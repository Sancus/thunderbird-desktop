/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WindowsMigrationPath.h"

#ifdef XP_WIN
#  include "mozilla/CheckedInt.h"
#  include "mozilla/Try.h"
#  include "nsIFile.h"
#  include "nsReadableUtils.h"
#  include "nsUnicharUtils.h"
#  include <utility>
#  include <windows.h>

namespace mozilla::mailnews {
namespace {

nsresult FileError(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_DRIVE:
      return NS_ERROR_FILE_NOT_FOUND;
    case ERROR_ACCESS_DENIED:
      return NS_ERROR_FILE_ACCESS_DENIED;
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION:
      return NS_ERROR_FILE_IS_LOCKED;
    default:
      return NS_ERROR_FAILURE;
  }
}

struct WalkedPath {
  nsString path;
  nsCString identity;
  nsCString parentIdentity;
  nsTArray<nsCString> ancestors;
  nsTArray<UniqueFileHandle> handles;
};

// No fallback to a truncated legacy file index on unsupported filesystems.
Result<nsCString, nsresult> FileIdentity(HANDLE handle) {
  FILE_ID_INFO info = {};
  if (!::GetFileInformationByHandleEx(handle, FileIdInfo, &info,
                                      sizeof(info))) {
    return Err(FileError(::GetLastError()));
  }
  const char hex[] = "0123456789abcdef";
  nsCString result;
  for (int shift = 60; shift >= 0; shift -= 4) {
    result.Append(hex[(info.VolumeSerialNumber >> shift) & 15]);
  }
  result.Append(':');
  for (uint8_t byte : info.FileId.Identifier) {
    result.Append(hex[byte >> 4]);
    result.Append(hex[byte & 15]);
  }
  return result;
}

Result<nsString, nsresult> FinalPath(HANDLE handle) {
  nsString path;
  path.SetLength(32768);
  DWORD length = ::GetFinalPathNameByHandleW(
      handle, reinterpret_cast<wchar_t*>(path.BeginWriting()), path.Length(),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length || length >= path.Length()) {
    return Err(NS_ERROR_FILE_INVALID_PATH);
  }
  path.SetLength(length);
  if (!StringBeginsWith(path, u"\\\\?\\"_ns)) {
    return Err(NS_ERROR_FILE_INVALID_PATH);
  }
  path.Cut(0, 4);
  return path;
}

// Extended-path opens bypass Win32 device translation; ordinary caller opens
// must still name the same file. Match reserved basenames before any extension.
bool IsReservedDeviceName(const nsAString& part) {
  int32_t dot = part.FindChar(u'.');
  nsAutoString base(
      Substring(part, 0, dot < 0 ? part.Length() : uint32_t(dot)));
  base.Trim(" ", false, true);
  static const nsLiteralString names[] = {
      u"CON"_ns,       u"PRN"_ns,       u"AUX"_ns,  u"NUL"_ns,
      u"CONIN$"_ns,    u"CONOUT$"_ns,   u"COM1"_ns, u"COM2"_ns,
      u"COM3"_ns,      u"COM4"_ns,      u"COM5"_ns, u"COM6"_ns,
      u"COM7"_ns,      u"COM8"_ns,      u"COM9"_ns, u"COM\u00B9"_ns,
      u"COM\u00B2"_ns, u"COM\u00B3"_ns, u"LPT1"_ns, u"LPT2"_ns,
      u"LPT3"_ns,      u"LPT4"_ns,      u"LPT5"_ns, u"LPT6"_ns,
      u"LPT7"_ns,      u"LPT8"_ns,      u"LPT9"_ns, u"LPT\u00B9"_ns,
      u"LPT\u00B2"_ns, u"LPT\u00B3"_ns};
  for (const auto& name : names) {
    if (base.Equals(name, nsASCIICaseInsensitiveStringComparator)) {
      return true;
    }
  }
  return false;
}

Result<WalkedPath, nsresult> Walk(nsIFile* file,
                                  WindowsMigrationPath::Kind kind) {
  nsAutoString path;
  MOZ_TRY(file->GetPath(path));
  // Refuse UNC/device/drive-relative paths, alternate streams and ambiguous
  // Win32 spellings instead of normalizing through an unchecked component.
  if (path.Length() < 3 || path.Length() > 32767 ||
      !((path[0] >= u'A' && path[0] <= u'Z') ||
        (path[0] >= u'a' && path[0] <= u'z')) ||
      path[1] != u':' || path[2] != u'\\') {
    return Err(NS_ERROR_FILE_INVALID_PATH);
  }
  nsAutoString drive(Substring(path, 0, 3));
  if (::GetDriveTypeW(drive.get()) != DRIVE_FIXED) {
    return Err(NS_ERROR_FILE_ACCESS_DENIED);
  }
  for (uint32_t begin = 3; begin < path.Length();) {
    int32_t found = path.FindChar(u'\\', begin);
    uint32_t end = found < 0 ? path.Length() : uint32_t(found);
    auto part = Substring(path, begin, end - begin);
    if (part.IsEmpty() || part.EqualsLiteral(".") || part.EqualsLiteral("..") ||
        part.Last() == u'.' || part.Last() == u' ' ||
        part.FindCharInSet(u":/?*\"<>|") != kNotFound ||
        part.FindChar(u'\0') != kNotFound || IsReservedDeviceName(part)) {
      return Err(NS_ERROR_FILE_INVALID_PATH);
    }
    begin = end + 1;
  }
  if (path.Length() > 3 && path.Last() == u'\\') {
    return Err(NS_ERROR_FILE_INVALID_PATH);
  }
  WalkedPath result;
  uint32_t end = 3;
  while (true) {
    bool leaf = end == path.Length();
    nsAutoString prefix(u"\\\\?\\"_ns);
    prefix.Append(Substring(path, 0, end));
    // Read/execute access enables share checks; attributes alone do not.
    // Directory handles deny DELETE but permit child operations. Source files
    // deny writers; existing stage files permit SQLite writes.
    bool requireDirectory =
        !leaf || kind == WindowsMigrationPath::Kind::Directory;
    DWORD access = FILE_READ_ATTRIBUTES |
                   (requireDirectory ? FILE_TRAVERSE : FILE_READ_DATA);
    DWORD sharing = FILE_SHARE_READ;
    if (requireDirectory || kind == WindowsMigrationPath::Kind::FileOrMissing) {
      sharing |= FILE_SHARE_WRITE;
    }
    UniqueFileHandle handle(::CreateFileW(
        prefix.get(), access, sharing, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    DWORD error = ::GetLastError();
    // CreateFileW fails with INVALID_HANDLE_VALUE, not just nullptr.
    if (!FileHandleIsValid(handle.get())) {
      if (leaf && kind == WindowsMigrationPath::Kind::FileOrMissing &&
          error == ERROR_FILE_NOT_FOUND && !result.handles.IsEmpty()) {
        result.parentIdentity = result.identity;
        result.identity.Truncate();
        if (result.path.Last() != u'\\') {
          result.path.Append(u'\\');
        }
        result.path.Append(Substring(path, path.RFindChar(u'\\') + 1));
        return result;
      }
      return Err(FileError(error));
    }
    BY_HANDLE_FILE_INFORMATION info = {};
    if (!::GetFileInformationByHandle(handle.get(), &info)) {
      return Err(FileError(::GetLastError()));
    }
    if (::GetFileType(handle.get()) != FILE_TYPE_DISK ||
        (info.dwFileAttributes &
         (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE))) {
      return Err(NS_ERROR_FILE_ACCESS_DENIED);
    }
    bool directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY;
    if (directory != requireDirectory) {
      return Err(NS_ERROR_FILE_INVALID_PATH);
    }
    result.parentIdentity = result.identity;
    auto identity = FileIdentity(handle.get());
    if (identity.isErr()) {
      return identity.propagateErr();
    }
    result.identity = identity.unwrap();
    result.ancestors.AppendElement(result.identity);
    auto finalPath = FinalPath(handle.get());
    if (finalPath.isErr()) {
      return finalPath.propagateErr();
    }
    result.path = finalPath.unwrap();
    result.handles.AppendElement(std::move(handle));
    if (leaf) {
      if (result.parentIdentity.IsEmpty()) {
        result.parentIdentity = result.identity;
      }
      return result;
    }
    int32_t next = path.FindChar(u'\\', end + (end == 3 ? 0 : 1));
    end = next < 0 ? path.Length() : uint32_t(next);
  }
}

}  // namespace

Result<UniquePtr<WindowsMigrationPath>, nsresult> WindowsMigrationPath::Admit(
    nsIFile* path, nsIFile* root, Kind kind) {
  if (!path || !root ||
      (kind != Kind::File && kind != Kind::Directory &&
       kind != Kind::FileOrMissing)) {
    return Err(NS_ERROR_INVALID_ARG);
  }
  auto rootResult = Walk(root, Kind::Directory);
  if (rootResult.isErr()) {
    return rootResult.propagateErr();
  }
  auto checkedRoot = rootResult.unwrap();
  auto pathResult = Walk(path, kind);
  if (pathResult.isErr()) {
    return pathResult.propagateErr();
  }
  auto checked = pathResult.unwrap();
  // Actual ancestor IDs also handle case-sensitive directories and 8.3 aliases.
  if (!checked.ancestors.Contains(checkedRoot.identity)) {
    return Err(NS_ERROR_FILE_ACCESS_DENIED);
  }
  UniquePtr<WindowsMigrationPath> result(new WindowsMigrationPath());
  result->mKind = kind;
  result->mPath = checked.path;
  result->mRootPath = checkedRoot.path;
  result->mIdentity = checked.identity;
  result->mParentIdentity = checked.parentIdentity;
  result->mRootIdentity = checkedRoot.identity;
  result->mHandles = std::move(checkedRoot.handles);
  for (auto& handle : checked.handles) {
    result->mHandles.AppendElement(std::move(handle));
  }
  return result;
}

nsresult WindowsMigrationPath::SetStageModificationTime(int64_t milliseconds) {
  if (mKind != Kind::FileOrMissing || !Exists() || mHandles.IsEmpty()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  // FILETIME uses 100ns ticks since 1601; inventory uses Unix milliseconds.
  CheckedInt<int64_t> ticks(milliseconds);
  ticks += 11644473600000LL;
  ticks *= 10000;
  if (!ticks.isValid() || ticks.value() <= 0) {
    return NS_ERROR_ILLEGAL_VALUE;
  }
  uint64_t value = static_cast<uint64_t>(ticks.value());
  FILETIME time = {static_cast<DWORD>(value), static_cast<DWORD>(value >> 32)};
  // Keep the admission alive; nsIFile's share-zero setter cannot coexist
  // with it. This open is metadata-only; the retained lease denies deletion.
  nsAutoString path(u"\\\\?\\"_ns);
  path.Append(mPath);
  UniqueFileHandle attributes(
      ::CreateFileW(path.get(), FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  DWORD error = ::GetLastError();
  if (!FileHandleIsValid(attributes.get())) {
    return FileError(error);
  }
  auto identity = FileIdentity(attributes.get());
  if (identity.isErr()) {
    return identity.unwrapErr();
  }
  if (identity.unwrap() != mIdentity) {
    return NS_ERROR_FILE_CORRUPTED;
  }
  if (!::SetFileTime(attributes.get(), nullptr, nullptr, &time)) {
    return FileError(::GetLastError());
  }
  return NS_OK;
}

}  // namespace mozilla::mailnews
#endif
