/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDERCOMPARATOR_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDERCOMPARATOR_H_

#include <cstdint>

#include "mozilla/Maybe.h"
#include "nsString.h"

namespace mozilla::intl {
class Collator;
}
namespace mozilla::mailnews {

/**
 * Compares folders for display in the right order. Folders with an ordinal in
 * the database are sorted ahead of those without. Folders without an ordinal
 * are sorted in alphabetical order.
 *
 * FolderDatabase prepares checked sort keys before invoking this comparator,
 * so comparison itself performs no database reads.
 */
class FolderComparator {
 public:
  struct Key {
    uint64_t id{0};
    Maybe<uint64_t> ordinal;
    uint32_t flags{0};
    nsCString name;
  };
  FolderComparator() = default;
  bool Equals(const Key& a, const Key& b) const;
  bool LessThan(const Key& a, const Key& b) const;

 private:
  uint8_t SpecialFlagsOrder(const uint32_t flags) const;
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDERCOMPARATOR_H_
