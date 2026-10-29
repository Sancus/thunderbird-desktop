/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WindowsMigrationPath.h"

#ifdef XP_WIN
#  include "nsCOMPtr.h"
#  include "nsDirectoryServiceDefs.h"
#  include "nsDirectoryServiceUtils.h"
#  include "nsIFile.h"
#  include "gtest/gtest.h"
#  include <cstring>
#  include <windows.h>
#  include <winioctl.h>

namespace mozilla::mailnews {
namespace {

class MigrationWindowsPath : public ::testing::Test {
 protected:
  void SetUp() override {
    ASSERT_EQ(NS_OK,
              NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mRoot)));
    ASSERT_EQ(NS_OK, mRoot->Append(u"migration-path"_ns));
    ASSERT_EQ(NS_OK, mRoot->CreateUnique(nsIFile::DIRECTORY_TYPE, 0700));
    mOwnRoot = true;
  }
  void TearDown() override {
    // Remove junction objects themselves before recursive test-directory
    // cleanup.
    for (const auto& path : mJunctions) {
      EXPECT_TRUE(::RemoveDirectoryW(path.get()));
    }
    if (mOwnRoot) {
      EXPECT_EQ(NS_OK, mRoot->Remove(true));
    }
  }
  nsCOMPtr<nsIFile> Child(const nsAString& name, bool directory = false) {
    nsCOMPtr<nsIFile> file;
    EXPECT_EQ(NS_OK, mRoot->Clone(getter_AddRefs(file)));
    EXPECT_EQ(NS_OK, file->Append(name));
    EXPECT_EQ(NS_OK, file->Create(directory ? nsIFile::DIRECTORY_TYPE
                                            : nsIFile::NORMAL_FILE_TYPE,
                                  0600));
    return file;
  }
  // Standard NTFS mount-point buffer. This creates a filesystem junction only,
  // never a legacy data fixture, and needs no symbolic-link privilege or shell.
  bool Junction(nsIFile* link, nsIFile* target) {
    nsAutoString linkPath, targetPath;
    if (NS_FAILED(link->GetPath(linkPath)) ||
        NS_FAILED(target->GetPath(targetPath))) {
      return false;
    }
    struct Header {
      DWORD tag;
      WORD size, reserved, substituteOffset, substituteLength, printOffset,
          printLength;
    };
    static_assert(sizeof(Header) == 16);
    nsAutoString substitute(u"\\??\\"_ns);
    substitute.Append(targetPath);
    nsTArray<uint8_t> bytes;
    bytes.SetLength(sizeof(Header) +
                    (substitute.Length() + targetPath.Length() + 2) *
                        sizeof(wchar_t));
    if (bytes.Length() > MAXIMUM_REPARSE_DATA_BUFFER_SIZE) {
      return false;
    }
    std::memset(bytes.Elements(), 0, bytes.Length());
    auto* header = reinterpret_cast<Header*>(bytes.Elements());
    header->tag = IO_REPARSE_TAG_MOUNT_POINT;
    header->size = static_cast<WORD>(bytes.Length() - 8);
    header->substituteLength =
        static_cast<WORD>(substitute.Length() * sizeof(wchar_t));
    header->printOffset =
        static_cast<WORD>((substitute.Length() + 1) * sizeof(wchar_t));
    header->printLength =
        static_cast<WORD>(targetPath.Length() * sizeof(wchar_t));
    auto* data = bytes.Elements() + sizeof(Header);
    std::memcpy(data, substitute.get(), header->substituteLength);
    std::memcpy(data + header->printOffset, targetPath.get(),
                header->printLength);
    UniqueFileHandle handle(::CreateFileW(
        linkPath.get(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    mJunctions.AppendElement(linkPath);
    DWORD returned = 0;
    if (!FileHandleIsValid(handle.get()) ||
        !::DeviceIoControl(handle.get(), FSCTL_SET_REPARSE_POINT,
                           bytes.Elements(), bytes.Length(), nullptr, 0,
                           &returned, nullptr)) {
      return false;
    }
    return true;
  }
  bool mOwnRoot = false;
  nsCOMPtr<nsIFile> mRoot;
  nsTArray<nsString> mJunctions;
};

TEST_F(MigrationWindowsPath, SourceIdentityAndExclusiveFutureStage) {
  auto file = Child(u"source.bin"_ns);
  auto source = WindowsMigrationPath::Admit(file, mRoot,
                                            WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(source.isOk());
  auto lease = source.unwrap();
  EXPECT_TRUE(lease->Exists());
  EXPECT_EQ(49u, lease->Identity().Length());
  EXPECT_EQ(49u, lease->RootIdentity().Length());
  EXPECT_NE(lease->Identity(), lease->ParentIdentity());
  nsCOMPtr<nsIFile> stage;
  ASSERT_EQ(NS_OK, mRoot->Clone(getter_AddRefs(stage)));
  ASSERT_EQ(NS_OK, stage->Append(u"stage.sqlite"_ns));
  auto future = WindowsMigrationPath::Admit(
      stage, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
  ASSERT_TRUE(future.isOk());
  auto parentLease = future.unwrap();
  EXPECT_FALSE(parentLease->Exists());
  EXPECT_TRUE(parentLease->Identity().IsEmpty());
  EXPECT_EQ(lease->RootIdentity(), parentLease->ParentIdentity());
  bool exists = true;
  ASSERT_EQ(NS_OK, stage->Exists(&exists));
  EXPECT_FALSE(exists);
  ASSERT_EQ(NS_OK, stage->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
  EXPECT_EQ(NS_ERROR_FILE_ALREADY_EXISTS,
            stage->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
  auto created = WindowsMigrationPath::Admit(
      stage, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
  ASSERT_TRUE(created.isOk());
  EXPECT_TRUE(created.inspect()->Exists());
  EXPECT_NE(lease->Identity(), created.inspect()->Identity());
  auto repeat = WindowsMigrationPath::Admit(file, mRoot,
                                            WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(repeat.isOk());
  EXPECT_EQ(lease->Identity(), repeat.inspect()->Identity());
}

TEST_F(MigrationWindowsPath, JunctionLeafAndAncestorAreRefused) {
  auto target = Child(u"target"_ns, true);
  auto link = Child(u"junction"_ns, true);
  ASSERT_TRUE(Junction(link, target));
  auto leaf = WindowsMigrationPath::Admit(
      link, mRoot, WindowsMigrationPath::Kind::Directory);
  ASSERT_TRUE(leaf.isErr());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, leaf.inspectErr());
  nsCOMPtr<nsIFile> below;
  ASSERT_EQ(NS_OK, link->Clone(getter_AddRefs(below)));
  ASSERT_EQ(NS_OK, below->Append(u"future.sqlite"_ns));
  auto descendant = WindowsMigrationPath::Admit(
      below, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
  ASSERT_TRUE(descendant.isErr());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, descendant.inspectErr());
  auto root = WindowsMigrationPath::Admit(
      target, link, WindowsMigrationPath::Kind::Directory);
  ASSERT_TRUE(root.isErr());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, root.inspectErr());
}

TEST_F(MigrationWindowsPath, OutsideRootAndDotComponentsAreRefused) {
  auto root = Child(u"admitted"_ns, true);
  auto outside = Child(u"outside.bin"_ns);
  auto foreign = WindowsMigrationPath::Admit(outside, root,
                                             WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(foreign.isErr());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, foreign.inspectErr());
  nsAutoString path;
  ASSERT_EQ(NS_OK, root->GetPath(path));
  path.Append(u"\\..\\outside.bin"_ns);
  nsCOMPtr<nsIFile> ambiguous;
  ASSERT_EQ(NS_OK, NS_NewLocalFile(path, getter_AddRefs(ambiguous)));
  auto dot = WindowsMigrationPath::Admit(ambiguous, root,
                                         WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(dot.isErr());
  EXPECT_EQ(NS_ERROR_FILE_INVALID_PATH, dot.inspectErr());
}

TEST_F(MigrationWindowsPath, MissingFileIsNotASourceLease) {
  nsCOMPtr<nsIFile> file;
  ASSERT_EQ(NS_OK, mRoot->Clone(getter_AddRefs(file)));
  ASSERT_EQ(NS_OK, file->Append(u"absent-source.msf"_ns));
  auto result = WindowsMigrationPath::Admit(
      file, mRoot, WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(result.isErr());
  EXPECT_EQ(NS_ERROR_FILE_NOT_FOUND, result.inspectErr());
  bool exists = true;
  ASSERT_EQ(NS_OK, file->Exists(&exists));
  EXPECT_FALSE(exists);
}

TEST_F(MigrationWindowsPath, MissingParentIsNotAnAbsentLeaf) {
  nsCOMPtr<nsIFile> file;
  ASSERT_EQ(NS_OK, mRoot->Clone(getter_AddRefs(file)));
  ASSERT_EQ(NS_OK, file->AppendRelativePath(u"absent\\stage.sqlite"_ns));
  auto result = WindowsMigrationPath::Admit(
      file, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
  ASSERT_TRUE(result.isErr());
  EXPECT_EQ(NS_ERROR_FILE_NOT_FOUND, result.inspectErr());
  bool exists = true;
  ASSERT_EQ(NS_OK, file->Exists(&exists));
  EXPECT_FALSE(exists);
}

TEST_F(MigrationWindowsPath, SourceLeaseBlocksRenameUntilReleased) {
  auto file = Child(u"source.bin"_ns);
  auto result = WindowsMigrationPath::Admit(file, mRoot,
                                            WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(result.isOk());
  auto lease = result.unwrap();
  nsAutoString before, after;
  ASSERT_EQ(NS_OK, file->GetPath(before));
  after.Assign(before);
  after.AppendLiteral(".renamed");
  BOOL moved = ::MoveFileExW(before.get(), after.get(), 0);
  DWORD error = ::GetLastError();
  EXPECT_FALSE(moved);
  EXPECT_EQ(DWORD(ERROR_SHARING_VIOLATION), error);
  lease.reset();
  EXPECT_TRUE(::MoveFileExW(before.get(), after.get(), 0));
}

TEST_F(MigrationWindowsPath, ExistingWriterPreventsSourceAdmission) {
  auto file = Child(u"source.bin"_ns);
  nsAutoString path;
  ASSERT_EQ(NS_OK, file->GetPath(path));
  UniqueFileHandle writer(
      ::CreateFileW(path.get(), FILE_WRITE_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, 0, nullptr));
  ASSERT_TRUE(FileHandleIsValid(writer.get()));
  auto blocked = WindowsMigrationPath::Admit(file, mRoot,
                                             WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(blocked.isErr());
  EXPECT_EQ(NS_ERROR_FILE_IS_LOCKED, blocked.inspectErr());
  writer.reset();
  auto admitted = WindowsMigrationPath::Admit(file, mRoot,
                                              WindowsMigrationPath::Kind::File);
  EXPECT_TRUE(admitted.isOk());
}

TEST_F(MigrationWindowsPath, SourceLeaseBlocksWriteUntilReleased) {
  auto file = Child(u"source.bin"_ns);
  nsAutoString path;
  ASSERT_EQ(NS_OK, file->GetPath(path));
  auto result = WindowsMigrationPath::Admit(file, mRoot,
                                            WindowsMigrationPath::Kind::File);
  ASSERT_TRUE(result.isOk());
  auto lease = result.unwrap();
  UniqueFileHandle writer(
      ::CreateFileW(path.get(), FILE_WRITE_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, 0, nullptr));
  DWORD error = ::GetLastError();
  EXPECT_FALSE(FileHandleIsValid(writer.get()));
  EXPECT_EQ(DWORD(ERROR_SHARING_VIOLATION), error);
  lease.reset();
  writer.reset(
      ::CreateFileW(path.get(), FILE_WRITE_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, 0, nullptr));
  EXPECT_TRUE(FileHandleIsValid(writer.get()));
}

TEST_F(MigrationWindowsPath,
       DirectoryLeaseDeniesDeleteButAllowsChildOperations) {
  auto directory = Child(u"owned-stage"_ns, true);
  nsAutoString path;
  ASSERT_EQ(NS_OK, directory->GetPath(path));
  auto result = WindowsMigrationPath::Admit(
      directory, mRoot, WindowsMigrationPath::Kind::Directory);
  ASSERT_TRUE(result.isOk());
  auto lease = result.unwrap();
  UniqueFileHandle deleter(::CreateFileW(
      path.get(), DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  DWORD error = ::GetLastError();
  EXPECT_FALSE(FileHandleIsValid(deleter.get()));
  EXPECT_EQ(DWORD(ERROR_SHARING_VIOLATION), error);
  nsCOMPtr<nsIFile> child;
  ASSERT_EQ(NS_OK, directory->Clone(getter_AddRefs(child)));
  ASSERT_EQ(NS_OK, child->Append(u"child.bin"_ns));
  ASSERT_EQ(NS_OK, child->Create(nsIFile::NORMAL_FILE_TYPE, 0600));
  nsAutoString before, after;
  ASSERT_EQ(NS_OK, child->GetPath(before));
  after.Assign(before);
  after.AppendLiteral(".renamed");
  EXPECT_TRUE(::MoveFileExW(before.get(), after.get(), 0));
  lease.reset();
  deleter.reset(::CreateFileW(
      path.get(), DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  EXPECT_TRUE(FileHandleIsValid(deleter.get()));
}

TEST_F(MigrationWindowsPath, ExistingDirectoryDeleteAccessPreventsAdmission) {
  auto directory = Child(u"owned-stage"_ns, true);
  nsAutoString path;
  ASSERT_EQ(NS_OK, directory->GetPath(path));
  UniqueFileHandle deleter(::CreateFileW(
      path.get(), DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  ASSERT_TRUE(FileHandleIsValid(deleter.get()));
  auto blocked = WindowsMigrationPath::Admit(
      directory, mRoot, WindowsMigrationPath::Kind::Directory);
  ASSERT_TRUE(blocked.isErr());
  EXPECT_EQ(NS_ERROR_FILE_IS_LOCKED, blocked.inspectErr());
  deleter.reset();
  auto admitted = WindowsMigrationPath::Admit(
      directory, mRoot, WindowsMigrationPath::Kind::Directory);
  EXPECT_TRUE(admitted.isOk());
}

TEST_F(MigrationWindowsPath, StageLeaseAllowsWriteButDeniesDeleteAccess) {
  auto file = Child(u"stage.sqlite"_ns);
  nsAutoString path;
  ASSERT_EQ(NS_OK, file->GetPath(path));
  auto result = WindowsMigrationPath::Admit(
      file, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
  ASSERT_TRUE(result.isOk());
  auto lease = result.unwrap();
  UniqueFileHandle writer(
      ::CreateFileW(path.get(), FILE_WRITE_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, 0, nullptr));
  ASSERT_TRUE(FileHandleIsValid(writer.get()));
  UniqueFileHandle deleter(
      ::CreateFileW(path.get(), DELETE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, 0, nullptr));
  DWORD error = ::GetLastError();
  EXPECT_FALSE(FileHandleIsValid(deleter.get()));
  EXPECT_EQ(DWORD(ERROR_SHARING_VIOLATION), error);
  lease.reset();
  deleter.reset(
      ::CreateFileW(path.get(), DELETE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, 0, nullptr));
  EXPECT_TRUE(FileHandleIsValid(deleter.get()));
}

TEST_F(MigrationWindowsPath, ReservedDevicesAreNotMissingFiles) {
  const nsLiteralString names[] = {u"con"_ns,
                                   u"PRN.txt"_ns,
                                   u"aux.sqlite"_ns,
                                   u"NUL .txt"_ns,
                                   u"CoNIN$.txt"_ns,
                                   u"conout$"_ns,
                                   u"COM1"_ns,
                                   u"COM9.sqlite"_ns,
                                   u"LPT1"_ns,
                                   u"LPT9.txt"_ns,
                                   u"COM\u00B9.txt"_ns,
                                   u"COM\u00B2"_ns,
                                   u"COM\u00B3"_ns,
                                   u"LPT\u00B9"_ns,
                                   u"LPT\u00B2.txt"_ns,
                                   u"LPT\u00B3"_ns,
                                   u"aux.sqlite\\future.sqlite"_ns};
  for (const auto& name : names) {
    SCOPED_TRACE(NS_ConvertUTF16toUTF8(name).get());
    nsAutoString path;
    ASSERT_EQ(NS_OK, mRoot->GetPath(path));
    path.Append(u'\\');
    path.Append(name);
    nsCOMPtr<nsIFile> file;
    ASSERT_EQ(NS_OK, NS_NewLocalFile(path, getter_AddRefs(file)));
    auto result = WindowsMigrationPath::Admit(
        file, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
    ASSERT_TRUE(result.isErr());
    EXPECT_EQ(NS_ERROR_FILE_INVALID_PATH, result.inspectErr());
  }
  nsCOMPtr<nsIFile> ordinary;
  ASSERT_EQ(NS_OK, mRoot->Clone(getter_AddRefs(ordinary)));
  ASSERT_EQ(NS_OK, ordinary->Append(u"auxiliary.sqlite"_ns));
  auto result = WindowsMigrationPath::Admit(
      ordinary, mRoot, WindowsMigrationPath::Kind::FileOrMissing);
  ASSERT_TRUE(result.isOk());
  EXPECT_FALSE(result.inspect()->Exists());
}

}  // namespace
}  // namespace mozilla::mailnews
#endif
