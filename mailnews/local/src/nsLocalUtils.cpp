/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsLocalUtils.h"
#include "prsystem.h"
#include "nsCOMPtr.h"
#include "prmem.h"
// stuff for temporary root folder hack
#include "nsIMsgAccountManager.h"
#include "nsIMsgIncomingServer.h"

#include "nsMsgUtils.h"
#include "nsNetCID.h"
#include "nsIURIMutator.h"
#include "mozilla/Components.h"
#ifdef MOZ_PANORAMA
#  include "mozilla/ResultExtensions.h"
#  include "nsIInputStream.h"
#  include "nsIMsgHdr.h"
#  include "nsIMsgFolder.h"
#  include "nsIMsgPluggableStore.h"
#  include "nsMailHeaders.h"
#  include "nsReadLine.h"
#  include "DatabaseCore.h"
#  include "MessageDatabase.h"
#  include "mozilla/AutoRestore.h"
#  include "mozilla/ClearOnShutdown.h"
#  include "mozilla/ScopeExit.h"
#  include "mozilla/StaticPtr.h"
#  include "mozilla/StaticPrefs_mail.h"
#  include "nsDirectoryServiceDefs.h"
#  include "nsAppDirectoryServiceDefs.h"
#  include "nsIBinaryInputStream.h"
#  include "nsIBinaryOutputStream.h"
#  include "nsIMsgDatabase.h"
#  include "nsISafeOutputStream.h"
#  include "nsMsgLocalStoreUtils.h"
#  include "nsNetUtil.h"
#  include "nsThreadUtils.h"
#endif

// it would be really cool to:
// - cache the last hostname->path match
// - if no such server exists, behave like an old-style mailbox URL
// (i.e. return the mail.directory preference or something)
static nsresult nsGetMailboxServer(const char* uriStr,
                                   nsIMsgIncomingServer** aResult) {
  nsresult rv = NS_OK;

  nsCOMPtr<nsIURL> url;
  rv = MsgNewStandardURL(nsDependentCString(uriStr), getter_AddRefs(url));
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsIMsgAccountManager> accountManager =
      mozilla::components::AccountManager::Service();
  // find all local mail "no servers" matching the given hostname
  nsCOMPtr<nsIMsgIncomingServer> none_server;
  rv = NS_MutateURI(url).SetScheme("none"_ns).Finalize(url);
  NS_ENSURE_SUCCESS(rv, rv);
  // No unescaping of username or hostname done here.
  // The unescaping is done inside of FindServerByURI
  rv = accountManager->FindServerByURI(url, getter_AddRefs(none_server));
  if (NS_SUCCEEDED(rv)) {
    none_server.forget(aResult);
    return rv;
  }

  // if that fails, look for the rss hosts matching the given hostname
  nsCOMPtr<nsIMsgIncomingServer> rss_server;
  rv = NS_MutateURI(url).SetScheme("rss"_ns).Finalize(url);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = accountManager->FindServerByURI(url, getter_AddRefs(rss_server));
  if (NS_SUCCEEDED(rv)) {
    rss_server.forget(aResult);
    return rv;
  }

  // if that fails, look for the pop hosts matching the given hostname
  nsCOMPtr<nsIMsgIncomingServer> server;
  if (NS_FAILED(rv)) {
    rv = NS_MutateURI(url).SetScheme("pop3"_ns).Finalize(url);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = accountManager->FindServerByURI(url, getter_AddRefs(server));

    // if we can't find a pop server, maybe it's a local message
    // in an imap hierarchy. look for an imap server.
    if (NS_FAILED(rv)) {
      rv = NS_MutateURI(url).SetScheme("imap"_ns).Finalize(url);
      NS_ENSURE_SUCCESS(rv, rv);
      rv = accountManager->FindServerByURI(url, getter_AddRefs(server));
    }
  }
  if (NS_SUCCEEDED(rv)) {
    server.forget(aResult);
    return rv;
  }

  // If you fail after looking at all "pop3", "none" servers, you fail.
  return rv;
}

static nsresult nsLocalURI2Server(const char* uriStr,
                                  nsIMsgIncomingServer** aResult) {
  nsresult rv;
  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = nsGetMailboxServer(uriStr, getter_AddRefs(server));
  server.forget(aResult);
  return rv;
}

// given rootURI and rootURI##folder, return on-disk path of folder
nsresult nsLocalURI2Path(const char* rootURI, const char* uriStr,
                         nsCString& pathResult) {
  nsresult rv;

  // verify that rootURI starts with "mailbox:/" or "mailbox-message:/"
  if ((PL_strcmp(rootURI, kMailboxRootURI) != 0) &&
      (PL_strcmp(rootURI, kMailboxMessageRootURI) != 0)) {
    return NS_ERROR_FAILURE;
  }

  // verify that uristr starts with rooturi
  nsAutoCString uri(uriStr);
  if (uri.Find(rootURI) != 0) return NS_ERROR_FAILURE;

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = nsLocalURI2Server(uriStr, getter_AddRefs(server));

  if (NS_FAILED(rv)) return rv;

  // now ask the server what it's root is
  // and begin pathResult with the mailbox root
  nsCOMPtr<nsIFile> localPath;
  rv = server->GetLocalPath(getter_AddRefs(localPath));
  NS_ENSURE_SUCCESS(rv, rv);

  nsAutoString localPathStr;
  rv = localPath->GetPath(localPathStr);
  NS_ENSURE_SUCCESS(rv, rv);
  CopyUTF16toUTF8(localPathStr, pathResult);
#if defined(XP_WIN)
  pathResult.Insert('/', 0);
  pathResult.ReplaceChar('\\', '/');
#endif
  const char* curPos = uriStr + PL_strlen(rootURI);
  if (curPos) {
    // advance past hostname
    while ((*curPos) == '/') curPos++;
    while (*curPos && (*curPos) != '/') curPos++;

    nsAutoString newPath;

    // Unescape folder name
    nsCString unescapedStr;
    MsgUnescapeString(nsDependentCString(curPos), 0, unescapedStr);
    NS_MsgCreatePathStringFromFolderURI(unescapedStr.get(), newPath);

    pathResult.Append('/');
    pathResult.Append(NS_ConvertUTF16toUTF8(newPath));
  }

  return NS_OK;
}

/* parses LocalMessageURI
 * mailbox-message://folder1/folder2#123?header=none or
 * mailbox-message://folder1/folder2#1234&part=1.2
 *
 * puts folder URI in folderURI (mailbox://folder1/folder2)
 * message key number in key
 */
nsresult nsParseLocalMessageURI(const nsACString& uri, nsCString& folderURI,
                                nsMsgKey* key) {
  if (!key) return NS_ERROR_NULL_POINTER;

  const nsPromiseFlatCString& uriStr = PromiseFlatCString(uri);
  int32_t keySeparator = uriStr.FindChar('#');
  if (keySeparator != -1) {
    int32_t keyEndSeparator = uriStr.FindCharInSet("?&", keySeparator);
    folderURI = StringHead(uriStr, keySeparator);
    // URI query repair can move compose parameters before the message key.
    // They are not part of the folder name.
    int32_t querySeparator = folderURI.FindChar('?');
    if (querySeparator != kNotFound) folderURI.Truncate(querySeparator);
    folderURI.Cut(7, 8);  // cut out the -message part of mailbox-message:

    nsAutoCString keyStr;
    if (keyEndSeparator != -1)
      keyStr = Substring(uriStr, keySeparator + 1,
                         keyEndSeparator - (keySeparator + 1));
    else
      keyStr = StringTail(uriStr, uriStr.Length() - (keySeparator + 1));

    *key = msgKeyFromInt(ParseUint64Str(keyStr.get()));
    return NS_OK;
  }
  return NS_ERROR_FAILURE;
}

nsresult nsBuildLocalMessageURI(const nsACString& baseURI, nsMsgKey key,
                                nsACString& uri) {
  // need to convert mailbox://hostname/.. to mailbox-message://hostname/..
  uri.Append(baseURI);
  uri.Append('#');
  uri.AppendInt(key);
  return NS_OK;
}

nsresult nsCreateLocalBaseMessageURI(const nsACString& baseURI,
                                     nsCString& baseMessageURI) {
  nsAutoCString tailURI(baseURI);

  // chop off mailbox:/
  if (tailURI.Find(kMailboxRootURI) == 0)
    tailURI.Cut(0, PL_strlen(kMailboxRootURI));

  baseMessageURI = kMailboxMessageRootURI;
  baseMessageURI += tailURI;

  return NS_OK;
}

#ifdef MOZ_PANORAMA
// Read the physical POP identity, not the message's non-unique Message-ID.
nsresult ReadPop3MessageIdentity(nsIMsgFolder* folder, nsIMsgDBHdr* header,
                                 nsACString& account, nsACString& uidl) {
  account.Truncate();
  uidl.Truncate();
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(folder->GetMsgInputStream(header, getter_AddRefs(stream)));
  nsLineBuffer<char> buffer;
  nsCString line;
  bool more = true;
  nsresult rv = NS_OK;
  constexpr auto accountPrefix =
      nsLiteralCString(HEADER_X_MOZILLA_ACCOUNT_KEY ": ");
  while (more) {
    rv = NS_ReadLine(stream.get(), &buffer, line, &more);
    if (NS_FAILED(rv) || line.IsEmpty()) break;
    if (StringBeginsWith(line, accountPrefix)) {
      account = Substring(line, accountPrefix.Length());
    } else if (StringBeginsWith(line, "X-UIDL: "_ns)) {
      uidl = Substring(line, sizeof("X-UIDL: ") - 1);
      break;
    }
  }
  nsresult closeRv = stream->Close();
  MOZ_TRY(rv);
  return closeRv;
}

// Measure the retrievable destination bytes, excluding mbox framing/escaping.
nsresult ReadStoredMessageDetails(nsIMsgPluggableStore* store,
                                  nsIMsgFolder* folder, const nsACString& token,
                                  uint32_t* size, uint32_t* lines) {
  if (token.IsEmpty()) {
    return NS_ERROR_UNEXPECTED;
  }
  nsCOMPtr<nsIInputStream> stream;
  MOZ_TRY(store->GetMsgInputStream(folder, token, 0, getter_AddRefs(stream)));
  uint64_t byteCount = 0;
  uint64_t bodyLines = 0;
  uint64_t lineLength = 0;
  bool inHeaders = true;
  char previous = 0;
  nsresult rv;
  char buffer[16384];
  while (true) {
    uint32_t count = 0;
    rv = stream->Read(buffer, sizeof(buffer), &count);
    if (NS_FAILED(rv) || !count) {
      break;
    }
    byteCount += count;
    if (byteCount > UINT32_MAX) {
      rv = NS_ERROR_ILLEGAL_VALUE;
      break;
    }
    for (uint32_t i = 0; i < count; ++i) {
      ++lineLength;
      if (buffer[i] == '\n') {
        if (inHeaders) {
          if (lineLength == 1 || (lineLength == 2 && previous == '\r')) {
            inHeaders = false;
          }
        } else {
          ++bodyLines;
        }
        lineLength = 0;
      }
      previous = buffer[i];
    }
  }
  nsresult closeRv = stream->Close();
  MOZ_TRY(rv);
  MOZ_TRY(closeRv);
  if (!inHeaders && lineLength) {
    ++bodyLines;
  }
  *size = static_cast<uint32_t>(byteCount);
  *lines = static_cast<uint32_t>(bodyLines);
  return NS_OK;
}

// This is the custody record for one local permanent-purge operation, not a
// SQL/body transaction. SQL commits before provider removal. A crash can leave
// a committed row removal with pending physical cleanup, never the reverse.
namespace {
using mozilla::mailnews::DatabaseCore;
using mozilla::mailnews::MessageBodyState;

enum class PurgePhase : uint8_t {
  Prepared,
  CommitRequested,
  MetadataRemoved,
  ProviderDone,
};
struct PurgeMember {
  MessageBodyState body;
  PurgePhase phase = PurgePhase::Prepared;
};
struct PurgeCustody {
  nsCOMPtr<nsIFile> directory;
  nsCString source;
  nsCString path;
  nsCString store;
  uint64_t folder = 0;
  nsresult firstError = NS_OK;
  nsTArray<PurgeMember> members;
};

mozilla::StaticAutoPtr<nsTArray<nsCString>> sPurging;
// Only the synchronous explicit-token provider call below may pass the fence.
nsIMsgFolder* sPurgeCleanupFolder = nullptr;
const nsCString* sPurgeCleanupToken = nullptr;

bool SamePurgeBody(const MessageBodyState& a, const MessageBodyState& b) {
  return a.databaseSourceId == b.databaseSourceId && a.key == b.key &&
         a.folderId == b.folderId && a.storeToken == b.storeToken &&
         a.contentRevision == b.contentRevision &&
         a.locationRevision == b.locationRevision && a.flags == b.flags &&
         a.messageSize == b.messageSize &&
         a.offlineMessageSize == b.offlineMessageSize &&
         a.lineCount == b.lineCount;
}

nsresult PurgeChild(nsIFile* parent, const nsACString& leaf, nsIFile** result) {
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(parent->Clone(getter_AddRefs(file)));
  MOZ_TRY(file->AppendNative(leaf));
  file.forget(result);
  return NS_OK;
}

nsresult PurgeLocation(nsIMsgFolder* folder, PurgeCustody& custody) {
  NS_ENSURE_ARG(folder);
  MOZ_ASSERT(NS_IsMainThread());
  // GetFilePath admits the current native wrapper before requesting a service.
  nsCOMPtr<nsIFile> path;
  MOZ_TRY(folder->GetFilePath(getter_AddRefs(path)));
  MOZ_TRY(path->GetNativePath(custody.path));
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_STATE(core);
  MOZ_TRY(core->GetSourceId(custody.source));
  NS_ENSURE_TRUE(!custody.source.IsEmpty() &&
                     custody.source.FindCharInSet("/\\") == kNotFound,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(folder->GetId(&custody.folder));
  MOZ_TRY(core->MessageDB().CheckFolderBodyAccess(custody.folder));
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(folder->GetMsgStore(getter_AddRefs(store)));
  MOZ_TRY(store->GetStoreType(custody.store));
  nsCOMPtr<nsIFile> root;
  MOZ_TRY(
      NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(root)));
  MOZ_TRY(root->AppendNative("panorama-purge"_ns));
  MOZ_TRY(root->AppendNative(custody.source));
  nsAutoCString id;
  id.AppendInt(custody.folder);
  MOZ_TRY(root->AppendNative(id));
  custody.directory = root;
  return NS_OK;
}

nsresult EnterPurge(PurgeCustody& custody) {
  if (!sPurging) {
    sPurging = new nsTArray<nsCString>();
    mozilla::ClearOnShutdown(&sPurging);
  }
  NS_ENSURE_FALSE(sPurging->Contains(custody.path), NS_ERROR_IN_PROGRESS);
  sPurging->AppendElement(custody.path);
  return NS_OK;
}

nsresult PurgeRecordFile(PurgeCustody& custody, nsIFile** result) {
  return PurgeChild(custody.directory, "state"_ns, result);
}

nsresult SavePurge(PurgeCustody& custody) {
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(PurgeRecordFile(custody, getter_AddRefs(file)));
  nsCOMPtr<nsIOutputStream> output;
  MOZ_TRY(NS_NewSafeLocalFileOutputStream(
      getter_AddRefs(output), file, PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE,
      00600));
  auto close = mozilla::MakeScopeExit([&] { output->Close(); });
  nsCOMPtr<nsIBinaryOutputStream> writer =
      do_CreateInstance("@mozilla.org/binaryoutputstream;1");
  NS_ENSURE_STATE(writer);
  MOZ_TRY(writer->SetOutputStream(output));
  MOZ_TRY(writer->Write32(0x50555231));  // PUR1
  MOZ_TRY(writer->WriteCString(custody.source));
  MOZ_TRY(writer->WriteCString(custody.path));
  MOZ_TRY(writer->WriteCString(custody.store));
  MOZ_TRY(writer->Write64(custody.folder));
  MOZ_TRY(writer->Write32(static_cast<uint32_t>(custody.firstError)));
  MOZ_TRY(writer->Write32(custody.members.Length()));
  for (const auto& member : custody.members) {
    const auto& b = member.body;
    MOZ_TRY(writer->Write64(b.key));
    MOZ_TRY(writer->WriteBoolean(b.storeToken.isSome()));
    MOZ_TRY(writer->WriteCString(b.storeToken.valueOr(nsCString())));
    MOZ_TRY(writer->Write64(b.contentRevision));
    MOZ_TRY(writer->Write64(b.locationRevision));
    MOZ_TRY(writer->Write32(b.messageSize));
    MOZ_TRY(writer->Write32(b.offlineMessageSize));
    MOZ_TRY(writer->Write32(b.lineCount));
    MOZ_TRY(writer->Write32(b.flags));
    MOZ_TRY(writer->Write8(static_cast<uint8_t>(member.phase)));
  }
  MOZ_TRY(writer->Flush());
  nsCOMPtr<nsISafeOutputStream> safe = do_QueryInterface(output);
  NS_ENSURE_STATE(safe);
  MOZ_TRY(safe->Finish());
  close.release();
  return NS_OK;
}

// Length-check before allocating strings from a truncated/corrupt record.
nsresult ReadPurgeText(nsIBinaryInputStream* reader, nsACString& text) {
  uint32_t length;
  MOZ_TRY(reader->Read32(&length));
  NS_ENSURE_TRUE(length <= 1024 * 1024, NS_ERROR_FILE_CORRUPTED);
  nsTArray<uint8_t> bytes;
  MOZ_TRY(reader->ReadByteArray(length, bytes));
  text.Assign(reinterpret_cast<const char*>(bytes.Elements()), bytes.Length());
  return NS_OK;
}

nsresult LoadPurge(PurgeCustody& custody) {
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(PurgeRecordFile(custody, getter_AddRefs(file)));
  nsCOMPtr<nsIInputStream> input;
  MOZ_TRY(NS_NewLocalFileInputStream(getter_AddRefs(input), file));
  auto close = mozilla::MakeScopeExit([&] { input->Close(); });
  nsCOMPtr<nsIBinaryInputStream> reader =
      do_CreateInstance("@mozilla.org/binaryinputstream;1");
  NS_ENSURE_STATE(reader);
  MOZ_TRY(reader->SetInputStream(input));
  uint32_t magic, error, count;
  uint64_t folder;
  nsCString source, path, store;
  MOZ_TRY(reader->Read32(&magic));
  NS_ENSURE_TRUE(magic == 0x50555231, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(ReadPurgeText(reader, source));
  MOZ_TRY(ReadPurgeText(reader, path));
  MOZ_TRY(ReadPurgeText(reader, store));
  MOZ_TRY(reader->Read64(&folder));
  NS_ENSURE_TRUE(source == custody.source && folder == custody.folder &&
                     path == custody.path && store == custody.store,
                 NS_ERROR_NOT_AVAILABLE);
  MOZ_TRY(reader->Read32(&error));
  custody.firstError = static_cast<nsresult>(error);
  MOZ_TRY(reader->Read32(&count));
  NS_ENSURE_TRUE(count <= 1000000, NS_ERROR_FILE_CORRUPTED);
  for (uint32_t i = 0; i < count; ++i) {
    auto& member = *custody.members.AppendElement();
    auto& b = member.body;
    uint64_t key;
    bool tokenPresent;
    nsCString token;
    uint8_t phase;
    MOZ_TRY(reader->Read64(&key));
    b.key = msgKeyFromInt(key);
    NS_ENSURE_TRUE(static_cast<uint64_t>(b.key) == key,
                   NS_ERROR_FILE_CORRUPTED);
    b.databaseSourceId = source;
    b.folderId = folder;
    MOZ_TRY(reader->ReadBoolean(&tokenPresent));
    MOZ_TRY(ReadPurgeText(reader, token));
    if (tokenPresent) b.storeToken.emplace(token);
    MOZ_TRY(reader->Read64(&b.contentRevision));
    MOZ_TRY(reader->Read64(&b.locationRevision));
    MOZ_TRY(reader->Read32(&b.messageSize));
    MOZ_TRY(reader->Read32(&b.offlineMessageSize));
    MOZ_TRY(reader->Read32(&b.lineCount));
    MOZ_TRY(reader->Read32(&b.flags));
    MOZ_TRY(reader->Read8(&phase));
    NS_ENSURE_TRUE(phase <= static_cast<uint8_t>(PurgePhase::ProviderDone),
                   NS_ERROR_FILE_CORRUPTED);
    member.phase = static_cast<PurgePhase>(phase);
    for (uint32_t j = 0; j < i; ++j) {
      NS_ENSURE_TRUE(custody.members[j].body.key != b.key &&
                         (!b.storeToken || b.storeToken->IsEmpty() ||
                          custody.members[j].body.storeToken != b.storeToken),
                     NS_ERROR_FILE_CORRUPTED);
    }
  }
  uint64_t extra;
  MOZ_TRY(input->Available(&extra));
  NS_ENSURE_TRUE(!extra, NS_ERROR_FILE_CORRUPTED);
  return input->Close();
}

nsresult PurgeBodyFile(PurgeCustody& custody, size_t index, nsIFile** result) {
  nsAutoCString leaf;
  leaf.AppendInt(index);
  leaf.AppendLiteral(".eml");
  return PurgeChild(custody.directory, leaf, result);
}

// Refuse any published or staged token owner before removing an orphan.
nsresult CheckPurgeTokenOwner(nsIMsgFolder* folder, DatabaseCore* core,
                              PurgeCustody& custody,
                              const MessageBodyState& expected, bool live) {
  nsTArray<nsMsgKey> keys;
  MOZ_TRY(core->MessageDB().ListStagedMessages(custody.folder, keys));
  NS_ENSURE_TRUE(keys.IsEmpty(), NS_ERROR_IN_PROGRESS);
  // Enumerate through the accepted public per-folder facade. The Core
  // implementation's ListAllKeys helper is private to its checked receivers.
  nsCOMPtr<nsIMsgDatabase> database;
  MOZ_TRY(folder->GetMsgDatabase(getter_AddRefs(database)));
  MOZ_TRY(database->ListAllKeys(keys));
  for (nsMsgKey key : keys) {
    MessageBodyState current;
    MOZ_TRY(core->MessageDB().GetMessageBodyState(key, current));
    if (key == expected.key) {
      NS_ENSURE_TRUE(live && SamePurgeBody(current, expected),
                     NS_ERROR_NOT_AVAILABLE);
    } else if (expected.storeToken && !expected.storeToken->IsEmpty()) {
      NS_ENSURE_TRUE(current.storeToken != expected.storeToken,
                     NS_ERROR_NOT_AVAILABLE);
    }
  }
  return NS_OK;
}

nsresult CleanPurgeMember(nsIMsgFolder* folder, PurgeCustody& custody,
                          PurgeMember& member) {
  if (member.phase == PurgePhase::ProviderDone) return NS_OK;
  if (member.body.storeToken && !member.body.storeToken->IsEmpty()) {
    const size_t index = &member - custody.members.Elements();
    nsCOMPtr<nsIFile> recovery;
    MOZ_TRY(PurgeBodyFile(custody, index, getter_AddRefs(recovery)));
    bool regular;
    MOZ_TRY(recovery->IsFile(&regular));
    NS_ENSURE_TRUE(regular, NS_ERROR_FILE_CORRUPTED);
    int64_t size;
    MOZ_TRY(recovery->GetFileSize(&size));
    NS_ENSURE_TRUE(size == member.body.messageSize, NS_ERROR_FILE_CORRUPTED);
  }
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_STATE(core);
  MOZ_TRY(core->MessageDB().CheckFolderBodyAccess(custody.folder));
  MOZ_TRY(CheckPurgeTokenOwner(folder, core, custody, member.body, false));
  if (member.body.storeToken && !member.body.storeToken->IsEmpty()) {
    nsCOMPtr<nsIMsgPluggableStore> store;
    MOZ_TRY(folder->GetMsgStore(getter_AddRefs(store)));
    mozilla::AutoRestore<nsIMsgFolder*> restoreFolder(sPurgeCleanupFolder);
    mozilla::AutoRestore<const nsCString*> restoreToken(sPurgeCleanupToken);
    sPurgeCleanupFolder = folder;
    sPurgeCleanupToken = &*member.body.storeToken;
    MOZ_TRY(store->DeleteStoreMessages(folder, {*member.body.storeToken}));
  }
  member.phase = PurgePhase::ProviderDone;
  return SavePurge(custody);
}

nsresult RemovePurgeCustody(PurgeCustody& custody) {
  // No recursive deletion: an unexpected file or a failed cleanup keeps the
  // record and fence, rather than silently discarding unresolved custody.
  for (size_t i = 0; i < custody.members.Length(); ++i) {
    nsCOMPtr<nsIFile> file;
    MOZ_TRY(PurgeBodyFile(custody, i, getter_AddRefs(file)));
    bool exists;
    MOZ_TRY(file->Exists(&exists));
    if (exists) MOZ_TRY(file->Remove(false));
  }
  nsCOMPtr<nsIFile> record;
  MOZ_TRY(PurgeRecordFile(custody, getter_AddRefs(record)));
  // Keep the state file until all other custody files have gone.
  MOZ_TRY(record->Remove(false));
  nsresult rv = custody.directory->Remove(false);
  if (NS_FAILED(rv)) {
    // Restore the record/fence if an unknown entry prevented directory removal.
    SavePurge(custody);
  }
  return rv;
}

nsresult RecoverPurge(nsIMsgFolder* folder, PurgeCustody& custody) {
  nsCOMPtr<nsIFile> record;
  MOZ_TRY(PurgeRecordFile(custody, getter_AddRefs(record)));
  bool exists;
  MOZ_TRY(record->Exists(&exists));
  if (!exists) return custody.directory->Remove(false);
  MOZ_TRY(LoadPurge(custody));
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_STATE(core);
  for (auto& member : custody.members) {
    MessageBodyState current;
    nsresult rv =
        core->MessageDB().GetMessageBodyState(member.body.key, current);
    if (NS_SUCCEEDED(rv)) {
      // Live original row: SQL did not commit, so provider removal was never
      // admitted. Do not retry that original selection or replay its callback.
      NS_ENSURE_TRUE(member.phase <= PurgePhase::CommitRequested &&
                         SamePurgeBody(current, member.body),
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(CheckPurgeTokenOwner(folder, core, custody, member.body, true));
    } else {
      NS_ENSURE_TRUE(rv == NS_ERROR_NOT_AVAILABLE, rv);
      NS_ENSURE_TRUE(member.phase >= PurgePhase::CommitRequested,
                     NS_ERROR_NOT_AVAILABLE);
      MOZ_TRY(CleanPurgeMember(folder, custody, member));
    }
  }
  return RemovePurgeCustody(custody);
}
}  // namespace

nsresult CheckNativePurgePending(nsIMsgFolder* folder) {
  if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) return NS_OK;
  PurgeCustody custody;
  MOZ_TRY(PurgeLocation(folder, custody));
  NS_ENSURE_FALSE(sPurging && sPurging->Contains(custody.path),
                  NS_ERROR_IN_PROGRESS);
  bool exists;
  MOZ_TRY(custody.directory->Exists(&exists));
  return exists ? NS_ERROR_IN_PROGRESS : NS_OK;
}

nsresult CheckNativePurgeRemoval(nsIMsgFolder* folder,
                                 const nsTArray<nsCString>& tokens) {
  if (sPurgeCleanupFolder == folder && sPurgeCleanupToken &&
      tokens.Length() == 1 && tokens[0] == *sPurgeCleanupToken)
    return NS_OK;
  return CheckNativePurgePending(folder);
}

nsresult RecoverNativePurge(nsIMsgFolder* folder) {
  if (!mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) return NS_OK;
  PurgeCustody custody;
  MOZ_TRY(PurgeLocation(folder, custody));
  bool exists;
  MOZ_TRY(custody.directory->Exists(&exists));
  if (!exists) return NS_OK;
  MOZ_TRY(EnterPurge(custody));
  auto leave =
      mozilla::MakeScopeExit([&] { sPurging->RemoveElement(custody.path); });
  nsresult rv = RecoverPurge(folder, custody);
  return NS_FAILED(rv) && NS_FAILED(custody.firstError) ? custody.firstError
                                                        : rv;
}

nsresult PurgeNativeMessages(
    nsIMsgFolder* folder, nsIMsgDatabase* database,
    const nsTArray<RefPtr<nsIMsgDBHdr>>& headers,
    nsTArray<RefPtr<nsIMsgDBHdr>>& removed,
    const std::function<void(nsIMsgDBHdr*)>& beforeRemove) {
  removed.Clear();
  MOZ_TRY(RecoverNativePurge(folder));
  PurgeCustody custody;
  MOZ_TRY(PurgeLocation(folder, custody));
  MOZ_TRY(mozilla::mailnews::CheckFolderStorageMove(folder));
  MOZ_TRY(EnterPurge(custody));
  auto leave =
      mozilla::MakeScopeExit([&] { sPurging->RemoveElement(custody.path); });
  RefPtr<DatabaseCore> core = DatabaseCore::GetInstanceForService();
  NS_ENSURE_STATE(core);
  nsCOMPtr<nsIMsgPluggableStore> store;
  MOZ_TRY(folder->GetMsgStore(getter_AddRefs(store)));
  for (const auto& header : headers) {
    nsCOMPtr<nsIMsgFolder> owner;
    MOZ_TRY(header->GetFolder(getter_AddRefs(owner)));
    NS_ENSURE_TRUE(owner == folder, NS_ERROR_ILLEGAL_VALUE);
    nsMsgKey key;
    MOZ_TRY(header->GetMessageKey(&key));
    auto& member = *custody.members.AppendElement();
    MOZ_TRY(core->MessageDB().GetMessageBodyState(key, member.body));
    NS_ENSURE_TRUE(member.body.folderId == custody.folder,
                   NS_ERROR_ILLEGAL_VALUE);
    nsAutoCString token;
    MOZ_TRY(header->GetStoreToken(token));
    NS_ENSURE_TRUE(token == member.body.storeToken.valueOr(nsCString()),
                   NS_ERROR_NOT_AVAILABLE);
    for (size_t j = 0; j + 1 < custody.members.Length(); ++j) {
      NS_ENSURE_TRUE(
          custody.members[j].body.key != key &&
              (token.IsEmpty() ||
               custody.members[j].body.storeToken != member.body.storeToken),
          NS_ERROR_ILLEGAL_VALUE);
    }
    MOZ_TRY(CheckPurgeTokenOwner(folder, core, custody, member.body, true));
    if (custody.store == "maildir" && !token.IsEmpty()) {
      // Preserve the ordinary nonempty-directory refusal before SQL changes.
      NS_ENSURE_TRUE(token.FindCharInSet("/\\") == kNotFound && token != "." &&
                         token != "..",
                     NS_ERROR_ILLEGAL_VALUE);
      nsCOMPtr<nsIFile> physical;
      MOZ_TRY(folder->GetFilePath(getter_AddRefs(physical)));
      MOZ_TRY(physical->AppendNative("cur"_ns));
      MOZ_TRY(physical->AppendNative(token));
      bool directory;
      MOZ_TRY(physical->IsDirectory(&directory));
      NS_ENSURE_FALSE(directory, NS_ERROR_FILE_DIR_NOT_EMPTY);
    }
  }
  if (headers.IsEmpty()) return NS_OK;
  // Create only this operation's generated private directory. No provider path
  // or arbitrary serialized filename is used for recovery-file writes.
  MOZ_TRY(custody.directory->Create(nsIFile::DIRECTORY_TYPE, 00700));
  MOZ_TRY(SavePurge(custody));
  auto fail = [&](nsresult rv) {
    if (NS_SUCCEEDED(custody.firstError)) custody.firstError = rv;
    SavePurge(custody);  // A secondary persistence error never hides rv.
    return rv;
  };
  for (size_t i = 0; i < headers.Length(); ++i) {
    auto& member = custody.members[i];
    if (!member.body.storeToken || member.body.storeToken->IsEmpty()) continue;
    nsCOMPtr<nsIFile> recovery;
    nsresult rv = PurgeBodyFile(custody, i, getter_AddRefs(recovery));
    if (NS_FAILED(rv)) return fail(rv);
    nsCOMPtr<nsIInputStream> input;
    rv = store->GetMsgInputStream(folder, *member.body.storeToken, 0,
                                  getter_AddRefs(input));
    if (NS_FAILED(rv)) return fail(rv);
    nsCOMPtr<nsIOutputStream> output;
    rv = MsgNewBufferedFileOutputStream(getter_AddRefs(output), recovery,
                                        PR_WRONLY | PR_CREATE_FILE | PR_EXCL,
                                        00600);
    if (NS_FAILED(rv)) {
      input->Close();
      return fail(rv);
    }
    uint64_t bytes;
    rv = SyncCopyStream(input, output, bytes);
    nsresult readClose = input->Close();
    nsresult writeClose = output->Close();
    if (NS_FAILED(rv)) return fail(rv);
    if (NS_FAILED(readClose)) return fail(readClose);
    if (NS_FAILED(writeClose)) return fail(writeClose);
    if (bytes != member.body.messageSize) return fail(NS_ERROR_NOT_AVAILABLE);
  }
  for (size_t i = 0; i < headers.Length(); ++i) {
    auto& member = custody.members[i];
    MessageBodyState current;
    nsresult rv =
        core->MessageDB().GetMessageBodyState(member.body.key, current);
    if (NS_FAILED(rv)) return fail(rv);
    if (!SamePurgeBody(current, member.body))
      return fail(NS_ERROR_NOT_AVAILABLE);
    rv = CheckPurgeTokenOwner(folder, core, custody, member.body, true);
    if (NS_FAILED(rv)) return fail(rv);
    member.phase = PurgePhase::CommitRequested;
    rv = SavePurge(custody);
    if (NS_FAILED(rv)) return fail(rv);
    beforeRemove(headers[i]);
    // The callback may synchronously run application observers. Recheck the
    // exact committed physical guard before admitting the SQL deletion.
    rv = core->MessageDB().GetMessageBodyState(member.body.key, current);
    if (NS_FAILED(rv)) return fail(rv);
    if (!SamePurgeBody(current, member.body))
      return fail(NS_ERROR_NOT_AVAILABLE);
    rv = database->DeleteHeader(headers[i], nullptr, false, true);
    if (NS_FAILED(rv)) return fail(rv);
    removed.AppendElement(headers[i]);
    member.phase = PurgePhase::MetadataRemoved;
    rv = SavePurge(custody);
    if (NS_FAILED(rv)) return fail(rv);
    rv = CleanPurgeMember(folder, custody, member);
    if (NS_FAILED(rv)) return fail(rv);
  }
  nsresult rv = RemovePurgeCustody(custody);
  return NS_FAILED(rv) ? fail(rv) : rv;
}

#endif
