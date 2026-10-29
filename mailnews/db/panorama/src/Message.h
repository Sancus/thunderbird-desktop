/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGE_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGE_H_

#include "DatabaseCore.h"
#include "nsIMsgHdr.h"
#include "nsTArray.h"

namespace mozilla::mailnews {

#define NS_DECODED_SUBJECT_HDR_IID                   \
  {                                                  \
    0xb28c6a7b, 0x952f, 0x4ad5, {                    \
      0x91, 0xd9, 0x51, 0x83, 0x80, 0x4a, 0x39, 0x65 \
    }                                                \
  }

// Internal capability: subject storage contains decoded UTF-8, not MIME words.
class DecodedSubjectHdr : public nsIMsgDBHdr {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_DECODED_SUBJECT_HDR_IID)
};

class Message : public DecodedSubjectHdr {
 public:
  Message() = delete;
  explicit Message(nsMsgKey key) : mKey(key) {};

  nsMsgKey Key() { return mKey; }
  // Currently needed for LiveView. Returns 0 upon error.
  uint64_t FolderId();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGDBHDR
 protected:
  virtual ~Message() {};

 private:
  nsresult ReadReferences(nsTArray<nsCString>& references);

  nsMsgKey mKey;

  FolderDatabase& FolderDB() const {
    return *DatabaseCore::sInstance->mFolderDatabase;
  }
  MessageDatabase& MessageDB() const {
    return *DatabaseCore::sInstance->mMessageDatabase;
  }
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_MESSAGE_H_
