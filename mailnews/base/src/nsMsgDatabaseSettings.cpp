/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgDatabaseSettings.h"

#include "nsDebug.h"

NS_IMPL_ISUPPORTS(nsMsgRetentionSettings, nsIMsgRetentionSettings)

// Initialise the member variables to reasonable defaults.
nsMsgRetentionSettings::nsMsgRetentionSettings()
    : m_retainByPreference(1),
      m_daysToKeepHdrs(0),
      m_numHeadersToKeep(0),
      m_useServerDefaults(true),
      m_applyToFlaggedMessages(false) {}

nsMsgRetentionSettings::~nsMsgRetentionSettings() {}

/* attribute unsigned long retainByPreference */
NS_IMETHODIMP nsMsgRetentionSettings::GetRetainByPreference(
    nsMsgRetainByPreference* retainByPreference) {
  NS_ENSURE_ARG_POINTER(retainByPreference);
  *retainByPreference = m_retainByPreference;
  return NS_OK;
}

NS_IMETHODIMP nsMsgRetentionSettings::SetRetainByPreference(
    nsMsgRetainByPreference retainByPreference) {
  m_retainByPreference = retainByPreference;
  return NS_OK;
}

/* attribute long daysToKeepHdrs; */
NS_IMETHODIMP nsMsgRetentionSettings::GetDaysToKeepHdrs(
    uint32_t* aDaysToKeepHdrs) {
  NS_ENSURE_ARG_POINTER(aDaysToKeepHdrs);
  *aDaysToKeepHdrs = m_daysToKeepHdrs;
  return NS_OK;
}

NS_IMETHODIMP nsMsgRetentionSettings::SetDaysToKeepHdrs(
    uint32_t aDaysToKeepHdrs) {
  m_daysToKeepHdrs = aDaysToKeepHdrs;
  return NS_OK;
}

/* attribute long numHeadersToKeep; */
NS_IMETHODIMP nsMsgRetentionSettings::GetNumHeadersToKeep(
    uint32_t* aNumHeadersToKeep) {
  NS_ENSURE_ARG_POINTER(aNumHeadersToKeep);
  *aNumHeadersToKeep = m_numHeadersToKeep;
  return NS_OK;
}

NS_IMETHODIMP nsMsgRetentionSettings::SetNumHeadersToKeep(
    uint32_t aNumHeadersToKeep) {
  m_numHeadersToKeep = aNumHeadersToKeep;
  return NS_OK;
}

/* attribute boolean useServerDefaults; */
NS_IMETHODIMP nsMsgRetentionSettings::GetUseServerDefaults(
    bool* aUseServerDefaults) {
  NS_ENSURE_ARG_POINTER(aUseServerDefaults);
  *aUseServerDefaults = m_useServerDefaults;
  return NS_OK;
}

NS_IMETHODIMP nsMsgRetentionSettings::SetUseServerDefaults(
    bool aUseServerDefaults) {
  m_useServerDefaults = aUseServerDefaults;
  return NS_OK;
}

/* attribute boolean applyToFlaggedMessages; */
NS_IMETHODIMP nsMsgRetentionSettings::GetApplyToFlaggedMessages(
    bool* aApplyToFlaggedMessages) {
  NS_ENSURE_ARG_POINTER(aApplyToFlaggedMessages);
  *aApplyToFlaggedMessages = m_applyToFlaggedMessages;
  return NS_OK;
}

NS_IMETHODIMP nsMsgRetentionSettings::SetApplyToFlaggedMessages(
    bool aApplyToFlaggedMessages) {
  m_applyToFlaggedMessages = aApplyToFlaggedMessages;
  return NS_OK;
}

NS_IMPL_ISUPPORTS(nsMsgDownloadSettings, nsIMsgDownloadSettings)

nsMsgDownloadSettings::nsMsgDownloadSettings() {
  m_useServerDefaults = false;
  m_downloadUnreadOnly = false;
  m_downloadByDate = false;
  m_ageLimitOfMsgsToDownload = 0;
}

nsMsgDownloadSettings::~nsMsgDownloadSettings() {}

/* attribute boolean useServerDefaults; */
NS_IMETHODIMP nsMsgDownloadSettings::GetUseServerDefaults(
    bool* aUseServerDefaults) {
  NS_ENSURE_ARG_POINTER(aUseServerDefaults);
  *aUseServerDefaults = m_useServerDefaults;
  return NS_OK;
}

NS_IMETHODIMP nsMsgDownloadSettings::SetUseServerDefaults(
    bool aUseServerDefaults) {
  m_useServerDefaults = aUseServerDefaults;
  return NS_OK;
}

/* attribute boolean downloadUnreadOnly; */
NS_IMETHODIMP nsMsgDownloadSettings::GetDownloadUnreadOnly(
    bool* aDownloadUnreadOnly) {
  NS_ENSURE_ARG_POINTER(aDownloadUnreadOnly);
  *aDownloadUnreadOnly = m_downloadUnreadOnly;
  return NS_OK;
}

NS_IMETHODIMP nsMsgDownloadSettings::SetDownloadUnreadOnly(
    bool aDownloadUnreadOnly) {
  m_downloadUnreadOnly = aDownloadUnreadOnly;
  return NS_OK;
}

/* attribute boolean downloadByDate; */
NS_IMETHODIMP nsMsgDownloadSettings::GetDownloadByDate(bool* aDownloadByDate) {
  NS_ENSURE_ARG_POINTER(aDownloadByDate);
  *aDownloadByDate = m_downloadByDate;
  return NS_OK;
}

NS_IMETHODIMP nsMsgDownloadSettings::SetDownloadByDate(bool aDownloadByDate) {
  m_downloadByDate = aDownloadByDate;
  return NS_OK;
}

/* attribute long ageLimitOfMsgsToDownload; */
NS_IMETHODIMP nsMsgDownloadSettings::GetAgeLimitOfMsgsToDownload(
    uint32_t* ageLimitOfMsgsToDownload) {
  NS_ENSURE_ARG_POINTER(ageLimitOfMsgsToDownload);
  *ageLimitOfMsgsToDownload = m_ageLimitOfMsgsToDownload;
  return NS_OK;
}

NS_IMETHODIMP nsMsgDownloadSettings::SetAgeLimitOfMsgsToDownload(
    uint32_t ageLimitOfMsgsToDownload) {
  m_ageLimitOfMsgsToDownload = ageLimitOfMsgsToDownload;
  return NS_OK;
}
