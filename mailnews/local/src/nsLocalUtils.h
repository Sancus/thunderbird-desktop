/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_LOCAL_SRC_NSLOCALUTILS_H_
#define COMM_MAILNEWS_LOCAL_SRC_NSLOCALUTILS_H_

#include "nsString.h"
#include "MailNewsTypes2.h"
#include "nsTArray.h"
#include "mozilla/RefPtr.h"
#include <functional>

static const char kMailboxRootURI[] = "mailbox:/";
static const char kMailboxMessageRootURI[] = "mailbox-message:/";

nsresult nsLocalURI2Path(const char* rootURI, const char* uriStr,
                         nsCString& pathResult);

nsresult nsParseLocalMessageURI(const nsACString& uri, nsCString& folderURI,
                                nsMsgKey* key);

nsresult nsBuildLocalMessageURI(const nsACString& baseURI, nsMsgKey key,
                                nsACString& uri);

nsresult nsCreateLocalBaseMessageURI(const nsACString& baseURI,
                                     nsCString& baseMessageURI);

#ifdef MOZ_PANORAMA
class nsIMsgDBHdr;
class nsIMsgFolder;
class nsIMsgPluggableStore;
class nsIMsgDatabase;

// Permanent native deletion only. Move/undo source retirement has its own
// accepted contract. On failure, removed contains only confirmed SQL commits.
nsresult PurgeNativeMessages(
    nsIMsgFolder* folder, nsIMsgDatabase* database,
    const nsTArray<RefPtr<nsIMsgDBHdr>>& headers,
    nsTArray<RefPtr<nsIMsgDBHdr>>& removed,
    const std::function<void(nsIMsgDBHdr*)>& beforeRemove);
// Reconcile a previous permanent purge before a new selection or reparse.
// This never replays metadata deletion, counts or copy-listener callbacks.
nsresult RecoverNativePurge(nsIMsgFolder* folder);
// Pending custody fences mutations/scans, but permits unchanged live reads.
nsresult CheckNativePurgePending(nsIMsgFolder* folder);
nsresult CheckNativePurgeRemoval(nsIMsgFolder* folder,
                                 const nsTArray<nsCString>& tokens);

nsresult ReadPop3MessageIdentity(nsIMsgFolder* folder, nsIMsgDBHdr* header,
                                 nsACString& account, nsACString& uidl);
nsresult ReadStoredMessageDetails(nsIMsgPluggableStore* store,
                                  nsIMsgFolder* folder, const nsACString& token,
                                  uint32_t* size, uint32_t* lines);
#endif

#endif  // COMM_MAILNEWS_LOCAL_SRC_NSLOCALUTILS_H_
