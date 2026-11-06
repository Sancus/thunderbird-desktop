/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FeedUtils } from "resource:///modules/FeedUtils.sys.mjs";

/**
 * Checks native process admission before starting an RSS writer.
 * The native gate retains process history and throws its original failure.
 */
function checkMigrationWriterAdmission() {
  if (!AppConstants.NIGHTLY_BUILD) {
    return;
  }
  const gate = Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIObserver
  );
  const subject = gate.QueryInterface(Ci.nsIPropertyBag2).getPropertyAsInterface(
    "writer-admission-subject",
    Ci.nsISupports
  );
  gate.observe(subject, "check-writer-admission", "rss");
}

export function FeedDownloader() {
  checkMigrationWriterAdmission();}
FeedDownloader.prototype = {
  downloadFeed(aFolder, aUrlListener, aIsBiff, aMsgWindow) {
    checkMigrationWriterAdmission();
    FeedUtils.downloadFeed(aFolder, aUrlListener, aIsBiff, aMsgWindow);
  },
  updateSubscriptionsDS(aFolder, aOrigFolder, aAction) {
    checkMigrationWriterAdmission();
    FeedUtils.updateSubscriptionsDS(aFolder, aOrigFolder, aAction);
  },

  QueryInterface: ChromeUtils.generateQI(["nsINewsBlogFeedDownloader"]),
};

export function FeedAcctMgrExtension() {}
FeedAcctMgrExtension.prototype = {
  name: "newsblog",
  chromePackageName: "messenger-newsblog",
  showPanel: () => false,

  QueryInterface: ChromeUtils.generateQI(["nsIMsgAccountManagerExtension"]),
};
