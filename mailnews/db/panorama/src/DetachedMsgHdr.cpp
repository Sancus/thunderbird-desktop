/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DetachedMsgHdr.h"

#include <algorithm>
#include <cstdlib>
#include <utility>

#include "mozilla/Components.h"
#include "mozilla/Try.h"
#include "nsIDatabaseCore.h"
#include "nsIFolderDatabase.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"

namespace mozilla::mailnews {

NS_IMPL_ISUPPORTS(DetachedMsgHdr, nsIMsgDBHdr, DecodedSubjectHdr)

nsresult DetachedMsgHdr::CheckMutable() const {
  if (mAttachState == AttachState::Attaching) {
    return NS_ERROR_IN_PROGRESS;
  }
  if (mAttachState == AttachState::Attached) {
    return NS_ERROR_ALREADY_INITIALIZED;
  }
  return mAttachError;
}

NS_IMETHODIMP DetachedMsgHdr::SetStringProperty(
    const char* propertyName, const nsACString& propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  MOZ_TRY(CheckMutable());
  auto& extra = *mRaw.extras.AppendElement();
  extra.k = propertyName;
  extra.v = propertyValue;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetStringProperty(const char* propertyName,
                                                nsACString& propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  nsDependentCString name(propertyName);
  // Explicit destination storage fields take precedence over extras.
  if (name.EqualsLiteral("messageSize") && mRaw.messageSize) {
    propertyValue.Truncate();
    propertyValue.AppendInt(*mRaw.messageSize);
  } else if (name.EqualsLiteral("offlineMessageSize") &&
             mRaw.offlineMessageSize) {
    propertyValue.Truncate();
    propertyValue.AppendInt(*mRaw.offlineMessageSize);
  } else if (name.EqualsLiteral("lineCount") && mRaw.lineCount) {
    propertyValue.Truncate();
    propertyValue.AppendInt(*mRaw.lineCount);
  } else if (name.EqualsLiteral("storeToken") && mRaw.storeToken) {
    propertyValue = *mRaw.storeToken;
  } else {
    for (size_t i = mRaw.extras.Length(); i > 0; --i) {
      const auto& extra = mRaw.extras[i - 1];
      if (extra.k.Equals(name)) {
        propertyValue = extra.v;
        return NS_OK;
      }
    }
    if (name.EqualsLiteral("keywords")) {
      propertyValue = mRaw.keywords;
    } else if (name.EqualsLiteral("msgCharSet")) {
      propertyValue = mRaw.charset;
    } else if (name.EqualsLiteral("account")) {
      propertyValue = mRaw.accountKey;
    } else if (name.EqualsLiteral("replyTo")) {
      propertyValue = mRaw.replyTo;
    } else {
      propertyValue.Truncate();
    }
  }
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetUint32Property(const char* propertyName,
                                                uint32_t* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  NS_ENSURE_ARG_POINTER(propertyValue);
  nsDependentCString name(propertyName);
  if (name.EqualsLiteral("keywords")) {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  nsAutoCString text;
  MOZ_TRY(GetStringProperty(propertyName, text));
  if (name.EqualsLiteral("messageSize") ||
      name.EqualsLiteral("offlineMessageSize") ||
      name.EqualsLiteral("lineCount") || name.EqualsLiteral("storeToken")) {
    // Match the live storage fields' SQLite decimal integer conversion.
    *propertyValue =
        static_cast<uint32_t>(std::strtoll(text.get(), nullptr, 10));
  } else {
    *propertyValue = static_cast<uint32_t>(
        MsgUnhex(text.get(), std::min<uint32_t>(8, text.Length())));
  }
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetUint32Property(const char* propertyName,
                                                uint32_t propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  MOZ_TRY(CheckMutable());
  nsDependentCString name(propertyName);
  if (name.EqualsLiteral("messageSize")) {
    return SetMessageSize(propertyValue);
  }
  if (name.EqualsLiteral("offlineMessageSize")) {
    return SetOfflineMessageSize(propertyValue);
  }
  if (name.EqualsLiteral("lineCount")) {
    return SetLineCount(propertyValue);
  }
  // The live numeric keywords property is distinct from message tags.
  if (name.EqualsLiteral("keywords")) {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  nsAutoCString text;
  text.AppendInt(propertyValue, name.EqualsLiteral("storeToken") ? 10 : 16);
  return SetStringProperty(propertyName, text);
}

NS_IMETHODIMP DetachedMsgHdr::GetProperties(nsTArray<nsCString>& properties) {
  nsTArray<nsCString> names;
  for (const auto& extra : mRaw.extras) {
    if (!names.Contains(extra.k)) {
      names.AppendElement(extra.k);
    }
  }
  if (mRaw.messageSize && !names.Contains("messageSize"_ns)) {
    names.AppendElement("messageSize"_ns);
  }
  if (mRaw.offlineMessageSize && !names.Contains("offlineMessageSize"_ns)) {
    names.AppendElement("offlineMessageSize"_ns);
  }
  if (mRaw.lineCount && !names.Contains("lineCount"_ns)) {
    names.AppendElement("lineCount"_ns);
  }
  if (mRaw.storeToken && !names.Contains("storeToken"_ns)) {
    names.AppendElement("storeToken"_ns);
  }
  properties = std::move(names);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetIsRead(bool* isRead) {
  *isRead = mRaw.flags & nsMsgMessageFlags::Read;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetIsFlagged(bool* isFlagged) {
  *isFlagged = mRaw.flags & nsMsgMessageFlags::Marked;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetIsKilled(bool* isKilled) {
  *isKilled = mRaw.flags & nsMsgMessageFlags::Ignored;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::MarkRead(bool read) {
  MOZ_TRY(CheckMutable());
  if (read) {
    mRaw.flags |= nsMsgMessageFlags::Read;
  } else {
    mRaw.flags &= ~nsMsgMessageFlags::Read;
  }
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::MarkFlagged(bool flagged) {
  MOZ_TRY(CheckMutable());
  if (flagged) {
    mRaw.flags |= nsMsgMessageFlags::Marked;
  } else {
    mRaw.flags &= ~nsMsgMessageFlags::Marked;
  }
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::MarkHasAttachments(bool hasAttachments) {
  MOZ_TRY(CheckMutable());
  if (hasAttachments) {
    mRaw.flags |= nsMsgMessageFlags::Attachment;
  } else {
    mRaw.flags &= ~nsMsgMessageFlags::Attachment;
  }
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetPriority(nsMsgPriorityValue* priority) {
  *priority = mRaw.priority;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetPriority(nsMsgPriorityValue priority) {
  MOZ_TRY(CheckMutable());
  mRaw.priority = priority;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetFlags(uint32_t* flags) {
  *flags = mRaw.flags;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetFlags(uint32_t flags) {
  MOZ_TRY(CheckMutable());
  mRaw.flags = flags;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::OrFlags(uint32_t flags, uint32_t* outFlags) {
  MOZ_TRY(CheckMutable());
  mRaw.flags |= flags;
  *outFlags = mRaw.flags;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::AndFlags(uint32_t flags, uint32_t* outFlags) {
  MOZ_TRY(CheckMutable());
  mRaw.flags &= flags;
  *outFlags = mRaw.flags;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetThreadId(nsMsgKey* threadId) {
  NS_ENSURE_ARG_POINTER(threadId);
  *threadId = mThreadId;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetThreadId(nsMsgKey threadId) {
  MOZ_TRY(CheckMutable());
  mThreadId = threadId;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetMessageKey(nsMsgKey* messageKey) {
  // Detached header should never have a key.
  MOZ_ASSERT(mRaw.key == nsMsgKey_None);
  *messageKey = mRaw.key;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetMessageKey(nsMsgKey messageKey) {
  NS_ERROR(__PRETTY_FUNCTION__);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::GetThreadParent(nsMsgKey* threadParent) {
  NS_ERROR(__PRETTY_FUNCTION__);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::SetThreadParent(nsMsgKey threadParent) {
  NS_ERROR(__PRETTY_FUNCTION__);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::GetMessageSize(uint32_t* messageSize) {
  NS_ENSURE_ARG_POINTER(messageSize);
  return GetUint32Property("messageSize", messageSize);
}

NS_IMETHODIMP DetachedMsgHdr::SetMessageSize(uint32_t messageSize) {
  MOZ_TRY(CheckMutable());
  mRaw.messageSize = Some(messageSize);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetLineCount(uint32_t* lineCount) {
  NS_ENSURE_ARG_POINTER(lineCount);
  return GetUint32Property("lineCount", lineCount);
}

NS_IMETHODIMP DetachedMsgHdr::SetLineCount(uint32_t lineCount) {
  MOZ_TRY(CheckMutable());
  mRaw.lineCount = Some(lineCount);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetStoreToken(nsACString& storeToken) {
  return GetStringProperty("storeToken", storeToken);
}

NS_IMETHODIMP DetachedMsgHdr::SetStoreToken(const nsACString& storeToken) {
  MOZ_TRY(CheckMutable());
  mRaw.storeToken = Some(nsCString(storeToken));
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetOfflineMessageSize(
    uint32_t* offlineMessageSize) {
  NS_ENSURE_ARG_POINTER(offlineMessageSize);
  return GetUint32Property("offlineMessageSize", offlineMessageSize);
}

NS_IMETHODIMP DetachedMsgHdr::SetOfflineMessageSize(
    uint32_t offlineMessageSize) {
  MOZ_TRY(CheckMutable());
  mRaw.offlineMessageSize = Some(offlineMessageSize);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetDate(PRTime* date) {
  *date = mRaw.date;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetDate(PRTime date) {
  MOZ_TRY(CheckMutable());
  mRaw.date = date;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetDateInSeconds(uint32_t* dateInSeconds) {
  *dateInSeconds = mRaw.date / PR_USEC_PER_SEC;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetMessageId(nsACString& messageId) {
  messageId.Assign(mRaw.messageId);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetMessageId(const nsACString& messageId) {
  MOZ_TRY(CheckMutable());
  mRaw.messageId = messageId;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetCcList(nsACString& ccList) {
  ccList.Assign(mRaw.ccList);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetCcList(const nsACString& ccList) {
  MOZ_TRY(CheckMutable());
  mRaw.ccList = ccList;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetBccList(nsACString& bccList) {
  bccList.Assign(mRaw.bccList);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetBccList(const nsACString& bccList) {
  MOZ_TRY(CheckMutable());
  mRaw.bccList = bccList;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetAuthor(nsACString& author) {
  author.Assign(mRaw.sender);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetAuthor(const nsACString& author) {
  MOZ_TRY(CheckMutable());
  mRaw.sender = author;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetSubject(nsACString& subject) {
  subject.Assign(mRaw.subject);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetSubject(const nsACString& subject) {
  MOZ_TRY(CheckMutable());
  mRaw.subject = subject;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetRecipients(nsACString& recipients) {
  recipients.Assign(mRaw.recipients);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetRecipients(const nsACString& recipients) {
  MOZ_TRY(CheckMutable());
  mRaw.recipients = recipients;
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::SetReferences(const nsACString& references) {
  MOZ_TRY(CheckMutable());
  mRaw.references = ParseIdentificationFields(references);
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetNumReferences(uint16_t* numReferences) {
  NS_WARNING(__PRETTY_FUNCTION__);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::GetStringReference(int32_t refNum,
                                                 nsACString& _retval) {
  NS_WARNING(__PRETTY_FUNCTION__);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::GetMime2DecodedAuthor(
    nsAString& mime2DecodedAuthor) {
  NS_WARNING(__PRETTY_FUNCTION__);
  mime2DecodedAuthor.Assign(NS_ConvertUTF8toUTF16(mRaw.sender));
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetMime2DecodedSubject(
    nsAString& mime2DecodedSubject) {
  NS_WARNING(__PRETTY_FUNCTION__);
  mime2DecodedSubject.Assign(NS_ConvertUTF8toUTF16(mRaw.subject));
  return NS_OK;
}

NS_IMETHODIMP DetachedMsgHdr::GetMime2DecodedRecipients(
    nsAString& mime2DecodedRecipients) {
  NS_WARNING(__PRETTY_FUNCTION__);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::GetCharset(nsACString& charset) {
  return GetStringProperty("msgCharSet", charset);
}

NS_IMETHODIMP DetachedMsgHdr::SetCharset(const nsACString& charset) {
  return SetStringProperty("msgCharSet", charset);
}

NS_IMETHODIMP DetachedMsgHdr::GetEffectiveCharset(
    nsACString& effectiveCharset) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP DetachedMsgHdr::GetAccountKey(nsACString& accountKey) {
  return GetStringProperty("account", accountKey);
}

NS_IMETHODIMP DetachedMsgHdr::SetAccountKey(const nsACString& accountKey) {
  return SetStringProperty("account", accountKey);
}

NS_IMETHODIMP DetachedMsgHdr::GetFolder(nsIMsgFolder** folder) {
  nsCOMPtr<nsIDatabaseCore> core = components::DatabaseCore::Service();
  nsCOMPtr<nsIFolderDatabase> folderDatabase;
  nsresult rv = core->GetFolderDB(getter_AddRefs(folderDatabase));
  NS_ENSURE_SUCCESS(rv, rv);

  return folderDatabase->GetMsgFolderForFolder(mFolderId, folder);
}

NS_IMETHODIMP DetachedMsgHdr::GetIsLive(bool* isLive) {
  // By definition, DetachedMsgHdr is never live.
  *isLive = false;
  return NS_OK;
}

}  // namespace mozilla::mailnews
