/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

add_setup(function setupStoreReads() {
  const pref = "mail.serverDefaultStoreContractID";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getCharPref(pref, "");
  registerCleanupFunction(() => {
    localAccountUtils.clearAll();
    if (hadPref) {
      Services.prefs.setCharPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });
  localAccountUtils.clearAll();
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The active database service matches the selected backend"
  );
});

/**
 * Read a provider stream, including closing it on a read error.
 *
 * @param {nsIInputStream} stream - Message input.
 * @returns {string} Exact stored message bytes.
 */
function readAll(stream) {
  const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  input.init(stream);
  try {
    let raw = "";
    let chunk;
    while ((chunk = input.read(4096))) {
      raw += chunk;
    }
    return raw;
  } finally {
    input.close();
  }
}

/**
 * Corrupt mbox tokens must fail instead of selecting a different body.
 */
add_task(async function test_mboxReadTokenValidation() {
  Services.prefs.setCharPref(
    "mail.serverDefaultStoreContractID",
    "@mozilla.org/msgstore/berkeleystore;1"
  );
  try {
    localAccountUtils.loadLocalMailAccount();
    const folder = localAccountUtils.inboxFolder;
    const store = folder.msgStore;
    Assert.equal(store.storeType, "mbox");
    Assert.equal(folder.server.msgStore.storeType, "mbox");
    const messages = [
      "Subject: First offset\r\n\r\nFirst exact body.\r\n",
      "Subject: Later offset\r\n\r\nLater exact body.\r\n",
    ];
    const tokens = [];
    for (const message of messages) {
      const stream = store.getNewMsgOutputStream(folder);
      stream.write(message, message.length);
      tokens.push(store.finishNewMessage(folder, stream));
    }
    const bytes = await IOUtils.read(folder.filePath.path);
    for (const token of [
      "",
      "not-an-offset",
      "0tail",
      "0x0",
      "+0",
      "-0",
      " 0",
      "0 ",
      "0\n",
      "0\0tail",
      "9223372036854775808",
      "18446744073709551616",
    ]) {
      Assert.throws(
        () => readAll(store.getMsgInputStream(folder, token, 0)),
        error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE,
        `Reject the complete invalid token ${JSON.stringify(token)}`
      );
    }
    Assert.equal(
      readAll(store.getMsgInputStream(folder, "0", 0)),
      messages[0],
      "Offset zero remains a valid body location"
    );
    Assert.equal(
      readAll(store.getMsgInputStream(folder, tokens[1], 0)),
      messages[1]
    );
    Assert.deepEqual(await IOUtils.read(folder.filePath.path), bytes);
    const scan = new PromiseTestUtils.PromiseStoreScanListener();
    store.asyncScan(folder, scan);
    await scan.promise;
    Assert.deepEqual(scan.messages, messages);
    Assert.deepEqual(scan.tokens, tokens);
  } finally {
    localAccountUtils.clearAll();
  }
});

/**
 * A failed read must leave a missing maildir directory missing.
 */
add_task(async function test_maildirReadMissingDirectory() {
  Services.prefs.setCharPref(
    "mail.serverDefaultStoreContractID",
    "@mozilla.org/msgstore/maildirstore;1"
  );
  try {
    localAccountUtils.loadLocalMailAccount();
    const folder = localAccountUtils.inboxFolder;
    const cur = PathUtils.join(folder.filePath.path, "cur");
    const saved = PathUtils.join(folder.filePath.path, "cur-for-read");
    const store = folder.msgStore;
    Assert.equal(store.storeType, "maildir");
    Assert.equal(folder.server.msgStore.storeType, "maildir");
    const message = "Subject: Retained maildir body\r\n\r\nExact body.\r\n";
    const stream = store.getNewMsgOutputStream(folder);
    stream.write(message, message.length);
    const token = store.finishNewMessage(folder, stream);
    await IOUtils.move(cur, saved, { noOverwrite: true });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        Assert.throws(
          () => readAll(store.getMsgInputStream(folder, token, 0)),
          error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND
        );
        Assert.ok(!(await IOUtils.exists(cur)), "Read creates no directory");
        Assert.equal(
          await IOUtils.readUTF8(PathUtils.join(saved, token)),
          message,
          "The missing-store error leaves the original body intact"
        );
      }
    } finally {
      // Remove only an empty directory created by a regressed read path.
      await IOUtils.remove(cur, { ignoreAbsent: true });
      await IOUtils.move(saved, cur, { noOverwrite: true });
    }
    Assert.equal(readAll(store.getMsgInputStream(folder, token, 0)), message);
    const scan = new PromiseTestUtils.PromiseStoreScanListener();
    store.asyncScan(folder, scan);
    await scan.promise;
    Assert.deepEqual(scan.messages, [message]);
    Assert.deepEqual(scan.tokens, [token]);
  } finally {
    localAccountUtils.clearAll();
  }
});
