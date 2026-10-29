/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mailnews_WindowsMigrationPath_h
#define mailnews_WindowsMigrationPath_h

#include "mozilla/Result.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/UniquePtrExtensions.h"
#include "nsError.h"
#include "nsString.h"
#include "nsTArray.h"

class nsIFile;

namespace mozilla::mailnews {

#ifdef XP_WIN
// Migration-only admission. Keep this owner alive through the file operation;
// handles deny deletion/renaming of checked components and source-file writes.
// Directories allow child operations; stage files allow their owner's writes.
// Writers still require caller ownership/quiescence and re-admission after
// creation. This does not authorize profile activation.
class WindowsMigrationPath final {
 public:
  enum class Kind { File, Directory, FileOrMissing };
  ~WindowsMigrationPath() = default;
  WindowsMigrationPath(const WindowsMigrationPath&) = delete;
  WindowsMigrationPath& operator=(const WindowsMigrationPath&) = delete;

  // Only local fixed-drive paths are supported. Refuses all reparse/offline
  // components, including above the admitted root. Never creates a missing
  // leaf. Call on original native paths before lexical normalization loses
  // components. The admitted root itself is also allowed.
  static Result<UniquePtr<WindowsMigrationPath>, nsresult> Admit(nsIFile* path,
                                                                 nsIFile* root,
                                                                 Kind kind);

  const nsString& Path() const { return mPath; }
  const nsString& RootPath() const { return mRootPath; }
  const nsCString& Identity() const { return mIdentity; }
  const nsCString& RootIdentity() const { return mRootIdentity; }
  const nsCString& ParentIdentity() const { return mParentIdentity; }
  bool Exists() const { return !mIdentity.IsEmpty(); }

  // Existing owner-writable stages only; retains every no-delete handle.
  nsresult SetStageModificationTime(int64_t milliseconds);

 private:
  WindowsMigrationPath() = default;
  Kind mKind = Kind::File;
  nsString mPath;
  nsString mRootPath;
  // Full 64-bit volume serial and 128-bit file ID, hexadecimal strings.
  // A missing leaf has no identity; its parent/root identities remain pinned.
  nsCString mIdentity;
  nsCString mRootIdentity;
  nsCString mParentIdentity;
  nsTArray<UniqueFileHandle> mHandles;
};
#endif

}  // namespace mozilla::mailnews

#endif
