/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Message.h"

#include <algorithm>
#include <cstring>
#include <limits>

#include "mozilla/Components.h"
#include "mozilla/Try.h"
#include "nsIMsgAccountManager.h"
#include "nsMsgMessageFlags.h"
#include "nsMsgUtils.h"
#include "nsString.h"
#include "prtime.h"

namespace mozilla::mailnews {

namespace {

// Preserve the existing numeric path for storage fields and the keywords alias.
bool UsesNativeUint32Property(const nsACString& name) {
  return name.EqualsLiteral("messageSize") ||
         name.EqualsLiteral("offlineMessageSize") ||
         name.EqualsLiteral("lineCount") || name.EqualsLiteral("storeToken") ||
         name.EqualsLiteral("keywords");
}

}  // namespace

NS_IMPL_ISUPPORTS(Message, nsIMsgDBHdr)

// LiveViewFilter::Match() currently needs this because it doesn't access DB.
// But we should ditch this.
uint64_t Message::FolderId() {
  uint64_t folderId;
  nsresult rv = MessageDB().GetMessageFolderId(mKey, folderId);
  if (NS_FAILED(rv)) {
    return 0;
  }
  return folderId;
}

NS_IMETHODIMP Message::SetStringProperty(const char* propertyName,
                                         const nsACString& propertyValue) {
  if (nsDependentCString(propertyName).EqualsLiteral("keywords")) {
    return MessageDB().SetMessageTags(mKey, propertyValue);
  }
  return MessageDB().SetMessageProperty(mKey, nsDependentCString(propertyName),
                                        propertyValue);
}

NS_IMETHODIMP Message::GetStringProperty(const char* propertyName,
                                         nsACString& propertyValue) {
  if (nsDependentCString(propertyName).EqualsLiteral("keywords")) {
    return MessageDB().GetMessageTags(mKey, propertyValue);
  }
  return MessageDB().GetMessageProperty(mKey, nsDependentCString(propertyName),
                                        propertyValue);
}

NS_IMETHODIMP Message::GetUint32Property(const char* propertyName,
                                         uint32_t* propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyValue);
  nsDependentCString name(propertyName);
  if (UsesNativeUint32Property(name)) {
    return MessageDB().GetMessageProperty(mKey, name, *propertyValue);
  }
  nsAutoCString text;
  MOZ_TRY(MessageDB().GetMessageProperty(mKey, name, text));
  *propertyValue = static_cast<uint32_t>(
      MsgUnhex(text.get(), std::min<uint32_t>(8, text.Length())));
  return NS_OK;
}

NS_IMETHODIMP Message::SetUint32Property(const char* propertyName,
                                         uint32_t propertyValue) {
  nsDependentCString name(propertyName);
  if (UsesNativeUint32Property(name)) {
    return MessageDB().SetMessageProperty(mKey, name, propertyValue);
  }
  nsAutoCString text;
  text.AppendInt(propertyValue, 16);
  return MessageDB().SetMessageProperty(mKey, name, text);
}

NS_IMETHODIMP Message::GetProperties(nsTArray<nsCString>& properties) {
  return MessageDB().GetMessagePropertyNames(mKey, properties);
}

NS_IMETHODIMP Message::GetIsRead(bool* isRead) {
  NS_ENSURE_ARG_POINTER(isRead);
  uint32_t flags;
  MOZ_TRY(MessageDB().GetMessageFlags(mKey, flags));
  *isRead = flags & nsMsgMessageFlags::Read;
  return NS_OK;
}

NS_IMETHODIMP Message::GetIsFlagged(bool* isFlagged) {
  NS_ENSURE_ARG_POINTER(isFlagged);
  uint32_t flags;
  MOZ_TRY(MessageDB().GetMessageFlags(mKey, flags));
  *isFlagged = flags & nsMsgMessageFlags::Marked;
  return NS_OK;
}

NS_IMETHODIMP Message::GetIsKilled(bool* isKilled) {
  NS_ENSURE_ARG_POINTER(isKilled);
  uint32_t flags;
  MOZ_TRY(MessageDB().GetMessageFlags(mKey, flags));
  *isKilled = flags & nsMsgMessageFlags::Ignored;
  return NS_OK;
}

NS_IMETHODIMP Message::MarkRead(bool read) {
  return MessageDB().SetMessageFlag(mKey, nsMsgMessageFlags::Read, read);
}

NS_IMETHODIMP Message::MarkFlagged(bool flagged) {
  return MessageDB().SetMessageFlag(mKey, nsMsgMessageFlags::Marked, flagged);
}

NS_IMETHODIMP Message::MarkHasAttachments(bool hasAttachments) {
  return MessageDB().SetMessageFlag(mKey, nsMsgMessageFlags::Attachment,
                                    hasAttachments);
}

NS_IMETHODIMP Message::GetPriority(nsMsgPriorityValue* priority) {
  NS_ENSURE_ARG_POINTER(priority);
  return MessageDB().GetMessagePriority(mKey, *priority);
}

NS_IMETHODIMP Message::SetPriority(nsMsgPriorityValue priority) {
  return MessageDB().SetMessagePriority(mKey, priority);
}

NS_IMETHODIMP Message::GetFlags(uint32_t* flags) {
  NS_ENSURE_ARG_POINTER(flags);
  return MessageDB().GetMessageFlags(mKey, *flags);
}

NS_IMETHODIMP Message::SetFlags(uint32_t flags) {
  return MessageDB().SetMessageFlags(mKey, flags);
}

NS_IMETHODIMP Message::OrFlags(uint32_t flags, uint32_t* outFlags) {
  uint32_t current;
  MOZ_TRY(MessageDB().GetMessageFlags(mKey, current));
  current |= flags;
  *outFlags = current;
  return MessageDB().SetMessageFlags(mKey, current);
}

NS_IMETHODIMP Message::AndFlags(uint32_t flags, uint32_t* outFlags) {
  uint32_t current;
  MOZ_TRY(MessageDB().GetMessageFlags(mKey, current));
  current &= flags;
  *outFlags = current;
  return MessageDB().SetMessageFlags(mKey, current);
}

NS_IMETHODIMP Message::GetThreadId(nsMsgKey* threadId) {
  NS_ENSURE_ARG_POINTER(threadId);
  return MessageDB().GetMessageThreadId(mKey, *threadId);
}

NS_IMETHODIMP Message::SetThreadId(nsMsgKey threadId) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP Message::GetMessageKey(nsMsgKey* key) {
  NS_ENSURE_ARG_POINTER(key);
  *key = mKey;
  return NS_OK;
}

NS_IMETHODIMP Message::SetMessageKey(nsMsgKey key) {
  return NS_ERROR_NOT_IMPLEMENTED;  // And never should be!
}

NS_IMETHODIMP Message::GetThreadParent(nsMsgKey* threadParent) {
  NS_ENSURE_ARG_POINTER(threadParent);
  return MessageDB().GetMessageThreadParent(mKey, *threadParent);
}

NS_IMETHODIMP Message::SetThreadParent(nsMsgKey threadParent) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP Message::GetMessageSize(uint32_t* messageSize) {
  NS_ENSURE_ARG_POINTER(messageSize);
  uint64_t size;
  MOZ_TRY(MessageDB().GetMessageSize(mKey, size));
  if (size > std::numeric_limits<uint32_t>::max()) {
    return NS_ERROR_UNEXPECTED;  // overflow.
  }
  *messageSize = size;
  return NS_OK;
}

NS_IMETHODIMP Message::SetMessageSize(uint32_t messageSize) {
  return MessageDB().SetMessageSize(mKey, (uint64_t)messageSize);
}

NS_IMETHODIMP Message::GetLineCount(uint32_t* lineCount) {
  NS_ENSURE_ARG_POINTER(lineCount);
  return MessageDB().GetMessageLineCount(mKey, *lineCount);
}

NS_IMETHODIMP Message::SetLineCount(uint32_t lineCount) {
  return MessageDB().SetMessageLineCount(mKey, lineCount);
}

NS_IMETHODIMP Message::GetStoreToken(nsACString& storeToken) {
  return MessageDB().GetMessageStoreToken(mKey, storeToken);
}

NS_IMETHODIMP Message::SetStoreToken(const nsACString& storeToken) {
  return MessageDB().SetMessageStoreToken(mKey, storeToken);
}

NS_IMETHODIMP Message::GetOfflineMessageSize(uint32_t* offlineMessageSize) {
  NS_ENSURE_ARG_POINTER(offlineMessageSize);
  uint64_t size;
  MOZ_TRY(MessageDB().GetMessageOfflineMessageSize(mKey, size));
  if (size > std::numeric_limits<uint32_t>::max()) {
    return NS_ERROR_ILLEGAL_INPUT;  // overflow.
  }
  *offlineMessageSize = size;
  return NS_OK;
}

NS_IMETHODIMP Message::SetOfflineMessageSize(uint32_t offlineMessageSize) {
  return MessageDB().SetMessageOfflineMessageSize(mKey,
                                                  (uint64_t)offlineMessageSize);
}

NS_IMETHODIMP Message::GetDate(PRTime* date) {
  NS_ENSURE_ARG_POINTER(date);
  return MessageDB().GetMessageDate(mKey, *date);
}

NS_IMETHODIMP Message::SetDate(PRTime date) {
  return MessageDB().SetMessageDate(mKey, date);
}

NS_IMETHODIMP Message::GetDateInSeconds(uint32_t* dateInSeconds) {
  NS_ENSURE_ARG_POINTER(dateInSeconds);
  PRTime t;
  MOZ_TRY(MessageDB().GetMessageDate(mKey, t));
  *dateInSeconds = t / PR_USEC_PER_SEC;
  return NS_OK;
}

NS_IMETHODIMP Message::GetMessageId(nsACString& messageId) {
  return MessageDB().GetMessageMessageId(mKey, messageId);
}

NS_IMETHODIMP Message::SetMessageId(const nsACString& messageId) {
  return MessageDB().SetMessageMessageId(mKey, messageId);
}

NS_IMETHODIMP Message::GetCcList(nsACString& ccList) {
  return MessageDB().GetMessageCcList(mKey, ccList);
}

NS_IMETHODIMP Message::SetCcList(const nsACString& ccList) {
  return MessageDB().SetMessageCcList(mKey, ccList);
}

NS_IMETHODIMP Message::GetBccList(nsACString& bccList) {
  return MessageDB().GetMessageBccList(mKey, bccList);
}

NS_IMETHODIMP Message::SetBccList(const nsACString& bccList) {
  return MessageDB().SetMessageBccList(mKey, bccList);
}

NS_IMETHODIMP Message::GetAuthor(nsACString& author) {
  return MessageDB().GetMessageSender(mKey, author);
}

NS_IMETHODIMP Message::SetAuthor(const nsACString& author) {
  return MessageDB().SetMessageSender(mKey, author);
}

NS_IMETHODIMP Message::GetSubject(nsACString& subject) {
  return MessageDB().GetMessageSubject(mKey, subject);
}

NS_IMETHODIMP Message::SetSubject(const nsACString& subject) {
  return MessageDB().SetMessageSubject(mKey, subject);
}

NS_IMETHODIMP Message::GetRecipients(nsACString& recipients) {
  return MessageDB().GetMessageRecipients(mKey, recipients);
}

NS_IMETHODIMP Message::SetRecipients(const nsACString& recipients) {
  return MessageDB().SetMessageRecipients(mKey, recipients);
}

NS_IMETHODIMP Message::SetReferences(const nsACString& references) {
  nsTArray<nsCString> parsed;
  const auto& raw = PromiseFlatCString(references);
  const char* cursor = raw.get();
  while (*cursor) {
    const char* start = std::strchr(cursor, '<');
    const char* end = start ? std::strchr(start + 1, '>') : nullptr;
    nsAutoCString token;
    if (end) {
      token.Assign(start + 1, end - start - 1);
    } else if (cursor == raw.get()) {
      // Legacy accepts one undelimited first value, preserving internal space.
      const char* first = cursor + std::strspn(cursor, " \r\n\t");
      if (*first == '<') {
        ++first;
      }
      token.Assign(first);
    }
    if (!token.IsEmpty()) {
      parsed.AppendElement(token);
    }
    if (!end) {
      break;
    }
    cursor = end + 1;
  }
  return MessageDB().SetMessageReferences(mKey, parsed);
}

nsresult Message::ReadReferences(nsTArray<nsCString>& references) {
  MOZ_TRY(MessageDB().GetMessageReferences(mKey, references));
  nsAutoCString messageId;
  MOZ_TRY(MessageDB().GetMessageMessageId(mKey, messageId));
  references.RemoveElementsBy([&](const nsCString& ref) {
    return ref.IsEmpty() || ref.Equals(messageId);
  });
  return NS_OK;
}

NS_IMETHODIMP Message::GetNumReferences(uint16_t* numReferences) {
  if (numReferences) {
    *numReferences = 0;
  }
  nsTArray<nsCString> references;
  MOZ_TRY(ReadReferences(references));
  if (numReferences) {
    if (references.Length() > std::numeric_limits<uint16_t>::max()) {
      return NS_ERROR_LOSS_OF_SIGNIFICANT_DATA;
    }
    *numReferences = static_cast<uint16_t>(references.Length());
  }
  return NS_OK;
}

NS_IMETHODIMP Message::GetStringReference(int32_t refNum,
                                          nsACString& reference) {
  nsTArray<nsCString> references;
  MOZ_TRY(ReadReferences(references));
  if (refNum < 0 || static_cast<uint32_t>(refNum) >= references.Length()) {
    return NS_ERROR_ILLEGAL_VALUE;
  }
  reference = references[refNum];
  return NS_OK;
}

NS_IMETHODIMP Message::GetMime2DecodedAuthor(nsAString& mime2DecodedAuthor) {
  nsAutoCString sender;
  MOZ_TRY(MessageDB().GetMessageSender(mKey, sender));
  mime2DecodedAuthor.Assign(NS_ConvertUTF8toUTF16(sender));
  return NS_OK;
}

NS_IMETHODIMP Message::GetMime2DecodedSubject(nsAString& mime2DecodedSubject) {
  nsAutoCString subject;
  MOZ_TRY(MessageDB().GetMessageSubject(mKey, subject));
  mime2DecodedSubject.Assign(NS_ConvertUTF8toUTF16(subject));
  return NS_OK;
}

NS_IMETHODIMP Message::GetMime2DecodedRecipients(
    nsAString& mime2DecodedRecipients) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP Message::GetCharset(nsACString& charset) {
  return GetStringProperty("msgCharSet", charset);
}

NS_IMETHODIMP Message::SetCharset(const nsACString& charset) {
  return SetStringProperty("msgCharSet", charset);
}

NS_IMETHODIMP Message::GetEffectiveCharset(nsACString& effectiveCharset) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP Message::GetAccountKey(nsACString& accountKey) {
  nsTArray<nsCString> names;
  MOZ_TRY(GetProperties(names));
  if (names.Contains("account"_ns)) {
    return GetStringProperty("account", accountKey);
  }

  uint64_t folderId;
  MOZ_TRY(MessageDB().GetMessageFolderId(mKey, folderId));
  uint64_t rootId;
  nsresult rv = FolderDB().GetFolderRoot(folderId, &rootId);
  NS_ENSURE_SUCCESS(rv, rv);

  // Get server name from name of root folder.
  nsCString serverKey;
  rv = FolderDB().GetFolderName(rootId, serverKey);
  NS_ENSURE_SUCCESS(rv, rv);

  // Get server using server name.
  nsCOMPtr<nsIMsgAccountManager> accountManager =
      components::AccountManager::Service();
  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = accountManager->GetIncomingServer(serverKey, getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);

  // Get account using server.
  nsCOMPtr<nsIMsgAccount> account;
  rv = accountManager->FindAccountForServer(server, getter_AddRefs(account));
  NS_ENSURE_SUCCESS(rv, rv);

  return account->GetKey(accountKey);
}

NS_IMETHODIMP Message::SetAccountKey(const nsACString& accountKey) {
  return SetStringProperty("account", accountKey);
}

NS_IMETHODIMP Message::GetFolder(nsIMsgFolder** aFolder) {
  NS_ENSURE_ARG_POINTER(aFolder);
  *aFolder = nullptr;
  uint64_t folderId;
  MOZ_TRY(MessageDB().GetMessageFolderId(mKey, folderId));
  return FolderDB().GetMsgFolderForFolder(folderId, aFolder);
}

NS_IMETHODIMP Message::GetIsLive(bool* isLive) {
  // By definition, Message is always live and in the database.
  *isLive = true;
  return NS_OK;
}

}  // namespace mozilla::mailnews
