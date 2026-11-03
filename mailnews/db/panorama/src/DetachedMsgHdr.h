/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_DETACHEDMSGHDR_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_DETACHEDMSGHDR_H_

#include "MailNewsTypes.h"
#include "Message.h"
#include "nsCOMPtr.h"
#include "nsIMsgDatabase.h"  // For struct RawHdr
#include "nsIMsgHdr.h"

namespace mozilla::mailnews {

class PerFolderDatabase;

#define NS_DETACHED_MSG_HDR_IID \
  {0x5fb65d55, 0x5737, 0x46b0, {0x9c, 0xe3, 0x48, 0xd3, 0xce, 0x59, 0x78, 0x9a}}

/**
 * An nsIMsgDBHdr which carries around its own data and is 'detached'
 * from the database.
 * Legacy code relies on being able to populate the nsIMsgDBHdr before
 * attaching it to the messages table in the database.
 * That's no good here, so we provide this detached implementation to use
 * up until the point it's added to the database, when it is exchanged for
 * the 'live' implementation (class Message).
 * See nsIMsgDatabase.addDetachedMsgHdrToDB().
 */
class DetachedMsgHdr : public DecodedSubjectHdr {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_DETACHED_MSG_HDR_IID)
  friend class PerFolderDatabase;
  friend class ParsedServerHdr;
  DetachedMsgHdr() = delete;
  explicit DetachedMsgHdr(uint64_t folderId) : mFolderId(folderId) {}

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGDBHDR
 protected:
  virtual ~DetachedMsgHdr() = default;
  // These fields can be read directly by PerFolderDatabase.

  // Metadata that is gleaned from parsing the message headers.
  RawHdr mRaw;

  // Snapshot identity is independent of the detached message key.
  nsMsgKey mThreadId{nsMsgKey_None};

  enum class AttachState { Editable, Attaching, Attached, Failed };
  nsresult CheckMutable() const;
  AttachState mAttachState = AttachState::Editable;
  nsresult mAttachError = NS_OK;
  nsCOMPtr<nsIMsgDBHdr> mAttachedHeader;

  // Opaque common-copy provenance and its one unpublished physical member.
  nsCString mCopySourceId;
  nsMsgKey mCopyStagedKey{nsMsgKey_None};
  bool mCopyPublishing = false;

  // Stuff I _really_ _really_ don't want here.
  uint64_t mFolderId{0};
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_DETACHEDMSGHDR_H_
