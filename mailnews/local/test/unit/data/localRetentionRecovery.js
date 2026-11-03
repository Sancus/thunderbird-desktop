/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals retentionRestartInput, print, quit */

/**
 * Read literal provider bytes through the accepted explicit-token interface.
 *
 * @param {nsIMsgFolder} folder - Native local folder.
 * @param {string} token - Captured physical provider token.
 * @returns {string} Exact stored bytes.
 */
function readRetentionBody(folder, token) {
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(folder.msgStore.getMsgInputStream(folder, token, 0));
  try {
    let raw = "";
    while (input.available()) raw += input.read(input.available());
    return raw;
  } finally {
    input.close();
  }
}

/** @returns {Promise<void>} The selected purge is written or recovered after restart. */
async function checkRestart() {
  const resources = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  resources.setSubstitution(
    "testing-common",
    Services.io.newURI(retentionRestartInput.testingCommon)
  );
  const { Assert } = ChromeUtils.importESModule(
    "resource://testing-common/Assert.sys.mjs"
  );
  const { updateAppInfo } = ChromeUtils.importESModule(
    "resource://testing-common/AppInfo.sys.mjs"
  );
  updateAppInfo();

  const profile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  profile.initWithPath(retentionRestartInput.profilePath);
  // Use the profile keys registered by the ordinary xpcshell harness.
  const profileProvider = {
    getFile(prop, persistent) {
      if (["ProfD", "ProfLD", "ProfDS", "ProfLDS", "TmpD"].includes(prop)) {
        persistent.value = true;
        return profile.clone();
      }
      return null;
    },
    QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
  };
  Services.dirsvc
    .QueryInterface(Ci.nsIDirectoryService)
    .registerProvider(profileProvider);
  for (const key of ["ProfD", "ProfLD", "ProfDS", "ProfLDS", "TmpD"]) {
    try {
      Services.dirsvc.undefine(key);
    } catch (error) {
      if (error.result != Cr.NS_ERROR_FAILURE) {
        throw error;
      }
    }
  }
  const prefsFile = profile.clone();
  prefsFile.append("prefs.js");
  if (retentionRestartInput.stage == "read") {
    Services.prefs.readUserPrefsFromFile(prefsFile);
  }
  Services.prefs.setBoolPref("security.nocertdb", true);
  Services.prefs.setBoolPref("mail.panorama.enabled", true);
  Services.obs.notifyObservers(
    null,
    "profile-do-change",
    "xpcshell-do-get-profile"
  );

  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { localAccountUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
  );

  const expectedPath = PathUtils.join(profile.path, "retention-recovery.json");
  const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  if (retentionRestartInput.stage == "write") {
    const contract =
      retentionRestartInput.store == "mbox"
        ? "@mozilla.org/msgstore/berkeleystore;1"
        : "@mozilla.org/msgstore/maildirstore;1";
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", contract);
    Services.prefs.setCharPref("mail.server.default.storeContractID", contract);
    localAccountUtils.loadLocalMailAccount();
    const folder = localAccountUtils.rootFolder
      .createLocalSubfolder("retention")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const entries = [];
    for (let i = 0; i < 3; ++i) {
      const raw =
        `From: retention@example.invalid\r\nSubject: Restart ${i}\r\n` +
        `Message-ID: <retention-restart-${i}@example.invalid>\r\n\r\nBody ${i}\r\n`;
      const header = folder.addMessage(raw);
      entries.push({
        key: header.messageKey,
        token: header.storeToken,
        raw,
        size: header.messageSize,
        lines: header.lineCount,
        flags: header.flags,
      });
    }
    const connection = core.connectionForTests;
    connection.executeSimpleSQL(
      "CREATE TEMP TRIGGER retention_restart_fault BEFORE DELETE ON main.messages " +
        `WHEN OLD.id = ${entries[1].key} BEGIN ` +
        "SELECT RAISE(ABORT, 'Late restart retention failure'); END"
    );
    try {
      Assert.throws(
        () =>
          folder.deleteMessages(
            entries
              .slice(0, 2)
              .map(entry => folder.msgDatabase.getMsgHdrForKey(entry.key)),
            null,
            true,
            false,
            null,
            false
          ),
        error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
      );
    } finally {
      connection.executeSimpleSQL("DROP TRIGGER temp.retention_restart_fault");
    }
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      entries.slice(1).map(entry => entry.key)
    );
    await IOUtils.writeJSON(expectedPath, {
      entries,
      source: core.sourceId,
      folderId: folder.id,
      uri: folder.URI,
      server: folder.server.key,
    });
    Services.prefs.savePrefFile(null);
  } else {
    const expected = await IOUtils.readJSON(expectedPath);
    const root = MailServices.accounts.getIncomingServer(
      expected.server
    ).rootFolder;
    const folder = root
      .getChildNamed("retention")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    Assert.equal(core.sourceId, expected.source);
    Assert.equal(folder.id, expected.folderId);
    Assert.equal(folder.URI, expected.uri);
    Assert.equal(folder.msgStore.storeType, retentionRestartInput.store);
    const pending = PathUtils.join(
      profile.path,
      "panorama-purge",
      core.sourceId,
      String(folder.id)
    );
    Assert.ok(await IOUtils.exists(pending));
    for (const entry of expected.entries.slice(1)) {
      const header = folder.msgDatabase.getMsgHdrForKey(entry.key);
      Assert.equal(header.storeToken, entry.token);
      Assert.equal(header.messageSize, entry.size);
      Assert.equal(header.lineCount, entry.lines);
      Assert.equal(header.flags, entry.flags);
      Assert.equal(readRetentionBody(folder, entry.token), entry.raw);
    }
    folder.updateFolder(null);
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      expected.entries.slice(1).map(entry => entry.key)
    );
    Assert.equal(folder.getTotalMessages(false), 2);
    Assert.ok(!(await IOUtils.exists(pending)));
    folder.updateFolder(null);
    Assert.equal(
      folder.getTotalMessages(false),
      2,
      "Recovery did not remove/account twice"
    );
    folder.deleteMessages(
      [folder.msgDatabase.getMsgHdrForKey(expected.entries[1].key)],
      null,
      true,
      false,
      null,
      false
    );
    Assert.deepEqual(folder.msgDatabase.listAllKeys(), [
      expected.entries[2].key,
    ]);
    Assert.equal(
      readRetentionBody(folder, expected.entries[2].token),
      expected.entries[2].raw
    );
    Assert.equal(folder.getTotalMessages(false), 1);
  }
  // Follow the ordinary xpcshell profile shutdown phases before exiting.
  Services.startup.advanceShutdownPhase(
    Services.startup.SHUTDOWN_PHASE_APPSHUTDOWNNETTEARDOWN
  );
  Services.startup.advanceShutdownPhase(
    Services.startup.SHUTDOWN_PHASE_APPSHUTDOWNTEARDOWN
  );
  Services.startup.advanceShutdownPhase(
    Services.startup.SHUTDOWN_PHASE_APPSHUTDOWN
  );
  Services.startup.advanceShutdownPhase(
    Services.startup.SHUTDOWN_PHASE_APPSHUTDOWNQM
  );
}

let settled = false;
let result = 0;
checkRestart().then(
  () => {
    print(`LOCAL-RETENTION-RESTART ${retentionRestartInput.stage} PASS`);
    settled = true;
  },
  error => {
    print(`LOCAL-RETENTION-RESTART FAIL ${error}\n${error.stack || ""}`);
    result = 1;
    settled = true;
  }
);
Services.tm.spinEventLoopUntil("TestLocalRetentionRestart", () => settled);
quit(result);
