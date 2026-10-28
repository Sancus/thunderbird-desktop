/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(function test_downloadSettingsStandaloneDefaultsAndRoundtrip() {
  const settings = Cc[
    "@mozilla.org/msgDatabase/downloadSettings;1"
  ].createInstance(Ci.nsIMsgDownloadSettings);
  Assert.equal(settings.useServerDefaults, false);
  Assert.equal(settings.downloadUnreadOnly, false);
  Assert.equal(settings.downloadByDate, false);
  Assert.equal(settings.ageLimitOfMsgsToDownload, 0);
  settings.useServerDefaults = true;
  settings.downloadUnreadOnly = true;
  settings.downloadByDate = true;
  for (const value of [1, 0x7fffffff, 0x80000000, 0xffffffff, 0]) {
    settings.ageLimitOfMsgsToDownload = value;
    Assert.equal(settings.ageLimitOfMsgsToDownload, value);
  }
  Assert.equal(settings.useServerDefaults, true);
  Assert.equal(settings.downloadUnreadOnly, true);
  Assert.equal(settings.downloadByDate, true);
  const another = Cc[
    "@mozilla.org/msgDatabase/downloadSettings;1"
  ].createInstance(Ci.nsIMsgDownloadSettings);
  Assert.equal(another.downloadByDate, false);
  Assert.equal(another.useServerDefaults, false);
});

add_task(function test_retentionSettingsStandaloneDefaultsAndRoundtrip() {
  const settings = Cc[
    "@mozilla.org/msgDatabase/retentionSettings;1"
  ].createInstance(Ci.nsIMsgRetentionSettings);
  Assert.equal(
    settings.retainByPreference,
    Ci.nsIMsgRetentionSettings.nsMsgRetainAll
  );
  Assert.equal(settings.daysToKeepHdrs, 0);
  Assert.equal(settings.numHeadersToKeep, 0);
  Assert.equal(settings.useServerDefaults, true);
  Assert.equal(settings.applyToFlaggedMessages, false);
  settings.retainByPreference = Ci.nsIMsgRetentionSettings.nsMsgRetainByAge;
  settings.useServerDefaults = false;
  settings.applyToFlaggedMessages = true;
  for (const value of [1, 0x7fffffff, 0x80000000, 0xffffffff, 0]) {
    settings.daysToKeepHdrs = value;
    settings.numHeadersToKeep = value;
    Assert.equal(settings.daysToKeepHdrs, value);
    Assert.equal(settings.numHeadersToKeep, value);
  }
  Assert.equal(
    settings.retainByPreference,
    Ci.nsIMsgRetentionSettings.nsMsgRetainByAge
  );
  Assert.equal(settings.useServerDefaults, false);
  Assert.equal(settings.applyToFlaggedMessages, true);
  const another = Cc[
    "@mozilla.org/msgDatabase/retentionSettings;1"
  ].createInstance(Ci.nsIMsgRetentionSettings);
  Assert.equal(another.useServerDefaults, true);
  Assert.equal(another.applyToFlaggedMessages, false);
});
