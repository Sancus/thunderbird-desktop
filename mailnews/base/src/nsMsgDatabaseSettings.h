/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGDATABASESETTINGS_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGDATABASESETTINGS_H_

#include "nsIMsgDatabase.h"
#include "nsISupportsImpl.h"

class nsMsgRetentionSettings : public nsIMsgRetentionSettings {
 public:
  nsMsgRetentionSettings();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGRETENTIONSETTINGS
 protected:
  virtual ~nsMsgRetentionSettings();
  nsMsgRetainByPreference m_retainByPreference;
  uint32_t m_daysToKeepHdrs;
  uint32_t m_numHeadersToKeep;
  bool m_useServerDefaults;
  bool m_applyToFlaggedMessages;
};

class nsMsgDownloadSettings : public nsIMsgDownloadSettings {
 public:
  nsMsgDownloadSettings();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGDOWNLOADSETTINGS
 protected:
  virtual ~nsMsgDownloadSettings();
  bool m_useServerDefaults;
  bool m_downloadUnreadOnly;
  bool m_downloadByDate;
  int32_t m_ageLimitOfMsgsToDownload;
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGDATABASESETTINGS_H_
