/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  getFolderIndexingPriority,
  getMailSearchPolicy,
  MAIL_SEARCH_MIME_OPTIONS,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchPolicy.sys.mjs"
);

const INDEXER_PREF = "mailnews.database.global.indexer.enabled";
let rootFolder;

add_setup(function setupPolicy() {
  do_get_profile();
  loadExistingDB();
  const hadPref = Services.prefs.prefHasUserValue(INDEXER_PREF);
  const oldPref = Services.prefs.getBoolPref(INDEXER_PREF, false);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(INDEXER_PREF, oldPref);
    } else {
      Services.prefs.clearUserPref(INDEXER_PREF);
    }
  });
  Services.prefs.setBoolPref(INDEXER_PREF, true);
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
});

/**
 * Adds a real local message without depending on search-index state.
 *
 * @param {string} name - Unique folder name.
 * @returns {nsIMsgDBHdr} The new physical header.
 */
function addPolicyMessage(name) {
  const folder = rootFolder
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  return folder.addMessage(
    [
      "From: Sender <sender@example.invalid>",
      "To: Recipient <recipient@example.invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <policy@example.invalid>",
      "Subject: Search policy",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Policy body.",
      "",
    ].join("\r\n")
  );
}

add_task(function test_globalFolderAndJunkPolicy() {
  const header = addPolicyMessage("eligibility");
  Assert.deepEqual(getMailSearchPolicy(header), {
    eligible: true,
    reason: "eligible",
    priority: 20,
  });
  Services.prefs.setBoolPref(INDEXER_PREF, false);
  Assert.equal(getMailSearchPolicy(header).reason, "disabled");
  Services.prefs.setBoolPref(INDEXER_PREF, true);

  header.setStringProperty("junkscore", "50");
  Assert.ok(
    getMailSearchPolicy(header).eligible,
    "Only the spam score excludes"
  );
  header.setStringProperty(
    "junkscore",
    Ci.nsIJunkMailPlugin.IS_SPAM_SCORE.toString()
  );
  Assert.equal(getMailSearchPolicy(header).reason, "junk");
  header.setStringProperty("junkscore", "");
  Assert.ok(getMailSearchPolicy(header).eligible);

  header.folder.setStringProperty("indexingPriority", "-1");
  Assert.equal(getMailSearchPolicy(header).reason, "excluded");
  header.folder.setStringProperty("indexingPriority", "40");
  Assert.equal(getMailSearchPolicy(header).priority, 40);
  header.folder.setFlag(Ci.nsMsgFolderFlags.Virtual);
  Assert.equal(getMailSearchPolicy(header).reason, "folder");
  header.folder.clearFlag(Ci.nsMsgFolderFlags.Virtual);
  header.flags |= Ci.nsMsgMessageFlags.Expunged;
  Assert.equal(getMailSearchPolicy(header).reason, "deleted");
});

add_task(function test_defaultPrioritiesAndExplicitOverride() {
  const flags = Ci.nsMsgFolderFlags;
  for (const [name, flag, expected] of [
    ["ordinary", 0, 20],
    ["inbox", flags.Inbox, 50],
    ["sent", flags.SentMail, 60],
    ["favorite", flags.Favorite, 40],
    ["check-new", flags.CheckNew, 30],
    ["queue", flags.Queue, -1],
    ["newsgroup", flags.Newsgroup, -1],
    ["policy-trash", flags.Trash, -1],
    ["junk", flags.Junk, -1],
  ]) {
    const folder = rootFolder.createLocalSubfolder(name);
    if (flag) {
      folder.setFlag(flag);
    }
    Assert.equal(getFolderIndexingPriority(folder), expected, name);
  }
  const trash = rootFolder
    .getChildNamed("policy-trash")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const child = trash.createLocalSubfolder("child");
  Assert.equal(
    getFolderIndexingPriority(child),
    -1,
    "Trash descendants exclude"
  );
  Assert.equal(getFolderIndexingPriority(child, true), 20);
  child.setStringProperty("indexingPriority", "30");
  Assert.equal(
    getFolderIndexingPriority(child),
    30,
    "An explicit choice survives"
  );
  child.setStringProperty("indexingPriority", "invalid");
  Assert.equal(
    getFolderIndexingPriority(child),
    -1,
    "Invalid preference uses defaults"
  );
});

add_task(function test_encryptedPartsRemainExcluded() {
  Assert.deepEqual(MAIL_SEARCH_MIME_OPTIONS, {
    saneBodySize: true,
    examineEncryptedParts: false,
  });
  Assert.ok(Object.isFrozen(MAIL_SEARCH_MIME_OPTIONS));
});
