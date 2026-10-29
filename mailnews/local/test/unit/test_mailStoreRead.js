/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const STORE_PREFS = [
  "mail.serverDefaultStoreContractID",
  "mail.server.default.storeContractID",
];

add_setup(function setupStoreReads() {
  const prefs = STORE_PREFS.map(name => ({
    name,
    hadValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  registerCleanupFunction(() => {
    try {
      localAccountUtils.clearAll();
    } finally {
      for (const { name, hadValue, value } of prefs) {
        if (hadValue) {
          Services.prefs.setCharPref(name, value);
        } else {
          Services.prefs.clearUserPref(name);
        }
      }
    }
  });
  localAccountUtils.clearAll();
});

/**
 * Create a local account before checking the selected database and store.
 *
 * @param {string} contract - Store contract.
 * @param {string} storeType - Expected store type.
 * @returns {nsIMsgLocalMailFolder} The local inbox.
 */
function loadStore(contract, storeType) {
  // Panorama root discovery can cache the provider before server creation ends.
  for (const name of STORE_PREFS) {
    Services.prefs.setCharPref(name, contract);
  }
  localAccountUtils.loadLocalMailAccount(contract);
  const folder = localAccountUtils.inboxFolder;
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The active database service matches the selected backend"
  );
  Assert.equal(folder.msgStore.storeType, storeType);
  Assert.equal(folder.server.msgStore.storeType, storeType);
  return folder;
}

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
  try {
    const folder = loadStore("@mozilla.org/msgstore/berkeleystore;1", "mbox");
    const store = folder.msgStore;
    const messages = [
      "From: first@example.invalid\r\nSubject: First offset\r\n\r\nFirst exact body.\r\n",
      "From: later@example.invalid\r\nSubject: Later offset\r\n\r\nLater exact body.\r\n",
    ];
    const tokens = [];
    for (const message of messages) {
      const stream = store.getNewMsgOutputStream(folder);
      stream.write(message, message.length);
      tokens.push(store.finishNewMessage(folder, stream));
    }
    Assert.equal(tokens[0], "0", "The first message starts at offset zero");
    Assert.notEqual(tokens[1], "0", "The later message has its own location");
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
  try {
    const folder = loadStore("@mozilla.org/msgstore/maildirstore;1", "maildir");
    const cur = PathUtils.join(folder.filePath.path, "cur");
    const saved = PathUtils.join(folder.filePath.path, "cur-for-read");
    const store = folder.msgStore;
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
