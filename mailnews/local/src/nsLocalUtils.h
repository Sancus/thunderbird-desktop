/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_LOCAL_SRC_NSLOCALUTILS_H_
#define COMM_MAILNEWS_LOCAL_SRC_NSLOCALUTILS_H_

#include "nsString.h"
#include "MailNewsTypes2.h"

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

nsresult ReadPop3MessageIdentity(nsIMsgFolder* folder, nsIMsgDBHdr* header,
                                 nsACString& account, nsACString& uidl);
nsresult ReadStoredMessageDetails(nsIMsgPluggableStore* store,
                                  nsIMsgFolder* folder, const nsACString& token,
                                  uint32_t* size, uint32_t* lines);
#endif

#endif  // COMM_MAILNEWS_LOCAL_SRC_NSLOCALUTILS_H_
