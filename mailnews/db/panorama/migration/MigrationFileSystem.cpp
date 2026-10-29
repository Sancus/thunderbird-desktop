/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MigrationFileSystem.h"
#include "WindowsMigrationPath.h"
#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsIFile.h"
#include "nsQueryObject.h"
#include <utility>

namespace mozilla::mailnews {

NS_IMPL_ISUPPORTS(MigrationFileSystem, nsIPanoramaMigrationFileSystem)

#ifdef XP_WIN
namespace {

#  define MIGRATION_PATH_IMPLEMENTATION_IID \
    {0xed65b112,                            \
     0x48cb,                                \
     0x4f12,                                \
     {0xb8, 0x5e, 0x2a, 0xee, 0xea, 0x53, 0x7b, 0x73}}

class MigrationPathLease final : public nsIPanoramaMigrationPath {
 public:
  NS_INLINE_DECL_STATIC_IID(MIGRATION_PATH_IMPLEMENTATION_IID)
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPANORAMAMIGRATIONPATH
  MigrationPathLease(UniquePtr<WindowsMigrationPath> admission,
                     nsIFile* original, nsIFile* root, uint16_t kind)
      : mAdmission(std::move(admission)),
        mOriginal(original),
        mRoot(root),
        mKind(kind) {}
  nsresult Check();

 private:
  ~MigrationPathLease() = default;
  UniquePtr<WindowsMigrationPath> mAdmission;
  nsCOMPtr<nsIFile> mOriginal;
  nsCOMPtr<nsIFile> mRoot;
  const uint16_t mKind;
};

NS_IMPL_ADDREF(MigrationPathLease)
NS_IMPL_RELEASE(MigrationPathLease)
NS_INTERFACE_MAP_BEGIN(MigrationPathLease)
  NS_INTERFACE_MAP_ENTRY(nsIPanoramaMigrationPath)
  NS_INTERFACE_MAP_ENTRY(nsISupports)
  NS_INTERFACE_MAP_ENTRY_CONCRETE(MigrationPathLease)
NS_INTERFACE_MAP_END

NS_IMETHODIMP MigrationPathLease::GetCanonicalPath(nsAString& value) {
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  value = mAdmission->Path();
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetCanonicalRoot(nsAString& value) {
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  value = mAdmission->RootPath();
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetIdentity(nsACString& value) {
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  value = mAdmission->Identity();
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetParentIdentity(nsACString& value) {
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  value = mAdmission->ParentIdentity();
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetRootIdentity(nsACString& value) {
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  value = mAdmission->RootIdentity();
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetKind(uint16_t* value) {
  NS_ENSURE_ARG_POINTER(value);
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  *value = mKind;
  if (mAdmission->Exists() &&
      mKind == nsIPanoramaMigrationFileSystem::KIND_FILE_OR_MISSING) {
    *value = nsIPanoramaMigrationFileSystem::KIND_FILE;
  }
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetExists(bool* value) {
  NS_ENSURE_ARG_POINTER(value);
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  *value = mAdmission->Exists();
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::GetClosed(bool* value) {
  NS_ENSURE_ARG_POINTER(value);
  *value = !mAdmission;
  return NS_OK;
}
NS_IMETHODIMP MigrationPathLease::Close() {
  mAdmission = nullptr;
  mOriginal = nullptr;
  mRoot = nullptr;
  return NS_OK;
}

nsresult MigrationPathLease::Check() {
  NS_ENSURE_TRUE(mAdmission, NS_ERROR_NOT_AVAILABLE);
  auto checked = WindowsMigrationPath::Admit(
      mOriginal, mRoot, static_cast<WindowsMigrationPath::Kind>(mKind));
  if (checked.isErr()) {
    return checked.unwrapErr();
  }
  const auto& current = checked.inspect();
  NS_ENSURE_TRUE(
      current->Path() == mAdmission->Path() &&
          current->RootPath() == mAdmission->RootPath() &&
          current->Identity() == mAdmission->Identity() &&
          current->ParentIdentity() == mAdmission->ParentIdentity() &&
          current->RootIdentity() == mAdmission->RootIdentity(),
      NS_ERROR_FILE_CORRUPTED);
  return NS_OK;
}

}  // namespace
#endif

NS_IMETHODIMP MigrationFileSystem::Admit(nsIFile* original, nsIFile* root,
                                         uint16_t kind,
                                         nsIPanoramaMigrationPath** result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = nullptr;
#ifdef XP_WIN
  static_assert(static_cast<uint16_t>(WindowsMigrationPath::Kind::File) ==
                KIND_FILE);
  static_assert(static_cast<uint16_t>(WindowsMigrationPath::Kind::Directory) ==
                KIND_DIRECTORY);
  static_assert(
      static_cast<uint16_t>(WindowsMigrationPath::Kind::FileOrMissing) ==
      KIND_FILE_OR_MISSING);
  NS_ENSURE_ARG(original);
  NS_ENSURE_ARG(root);
  NS_ENSURE_TRUE(kind <= KIND_FILE_OR_MISSING, NS_ERROR_INVALID_ARG);
  nsCOMPtr<nsIFile> originalCopy, rootCopy;
  nsresult rv = original->Clone(getter_AddRefs(originalCopy));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = root->Clone(getter_AddRefs(rootCopy));
  NS_ENSURE_SUCCESS(rv, rv);
  auto admission = WindowsMigrationPath::Admit(
      originalCopy, rootCopy, static_cast<WindowsMigrationPath::Kind>(kind));
  if (admission.isErr()) {
    return admission.unwrapErr();
  }
  RefPtr<MigrationPathLease> lease =
      new MigrationPathLease(admission.unwrap(), originalCopy, rootCopy, kind);
  lease.forget(result);
  return NS_OK;
#else
  return NS_ERROR_NOT_IMPLEMENTED;
#endif
}

NS_IMETHODIMP MigrationFileSystem::Validate(nsISupports* lease) {
#ifdef XP_WIN
  RefPtr<MigrationPathLease> native = do_QueryObject(lease);
  NS_ENSURE_TRUE(native, NS_ERROR_INVALID_ARG);
  return native->Check();
#else
  return NS_ERROR_NOT_IMPLEMENTED;
#endif
}

}  // namespace mozilla::mailnews
