/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mailnews_MigrationFileSystem_h
#define mailnews_MigrationFileSystem_h

#include "nsIPanoramaMigrationFileSystem.h"

namespace mozilla::mailnews {

class MigrationFileSystem final : public nsIPanoramaMigrationFileSystem {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPANORAMAMIGRATIONFILESYSTEM
  MigrationFileSystem() = default;

 private:
  ~MigrationFileSystem() = default;
};

}  // namespace mozilla::mailnews
#endif
