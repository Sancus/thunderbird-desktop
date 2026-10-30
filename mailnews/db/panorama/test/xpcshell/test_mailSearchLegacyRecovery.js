/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);

const BODY = "Unquoted café 自動 text";
const DATASTORE_MODULE = "resource:///modules/gloda/GlodaDatastore.sys.mjs";
let readLegacyGlodaMail, locations, snapshotPath, originalFiles;

add_setup(async function createGenuineLegacySnapshot() {
  do_get_profile();
  Assert.equal(Services.prefs.getBoolPref("mail.panorama.enabled"), false);
  Assert.equal(
    Services.prefs.getBoolPref(
      "security.storage.encryption.sqlite.enabled",
      false
    ),
    false
  );
  Assert.ok(!Cu.isESModuleLoaded(DATASTORE_MODULE));
  ({ readLegacyGlodaMail } = ChromeUtils.importESModule(
    "resource:///modules/panorama/LegacyGlodaMailReader.sys.mjs"
  ));
  Assert.ok(
    !Cu.isESModuleLoaded(DATASTORE_MODULE),
    "The standalone reader does not load the legacy writer"
  );
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const serviceContract = "@mozilla.org/msgDatabase/msgDBService;1";
  Assert.equal(
    registrar.contractIDToCID(serviceContract).toString(),
    "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}"
  );
  Assert.equal(
    registrar
      .contractIDToCID("@mozilla.org/nsMsgDatabase/msgDB-mailbox")
      .toString(),
    "{a86c86ae-e97f-11d2-a506-0060b0fc04b7}"
  );
  const backend = Cc[serviceContract].getService(Ci.nsIMsgDBService);
  Assert.ok(
    !(backend instanceof Ci.nsIDatabaseCore),
    "The reference producer uses the actual legacy backend"
  );
  const {
    glodaTestHelperInitialize,
    waitForGlodaIndexer,
    assertExpectedMessagesIndexed,
  } = ChromeUtils.importESModule(
    "resource://testing-common/gloda/GlodaTestHelper.sys.mjs"
  );
  const generator = new MessageGenerator();
  const injection = new MessageInjection({ mode: "local" }, generator);
  glodaTestHelperInitialize(injection);
  const headers = [];
  const messageSets = [];
  for (const name of ["plain", "attachment"]) {
    const folder = await injection.makeEmptyFolder("legacy-recovery-" + name);
    Assert.equal(folder.msgStore.storeType, "mbox");
    const message = generator.makeMessage({
      subject: "Legacy recovery " + name,
      from: ["Sender", "sender@example.invalid"],
      to: [["Recipient", "recipient@example.invalid"]],
      body: {
        body: MailStringUtils.stringToByteString(BODY),
        charset: "UTF-8",
        encoding: "8bit",
        format: null,
      },
      ...(name == "attachment"
        ? { attachments: [{ filename: "recovery.txt", body: "attachment" }] }
        : {}),
    });
    message.messageId = "recovery-" + name + "@example.invalid";
    const messages = new SyntheticMessageSet([message]);
    await injection.addSetsToFolders([folder], [messages]);
    messageSets.push(messages);
    headers.push(messages.getMsgHdr(0));
  }
  const { Gloda } = ChromeUtils.importESModule(
    "resource:///modules/gloda/GlodaPublic.sys.mjs"
  );
  const { GlodaIndexer } = ChromeUtils.importESModule(
    "resource:///modules/gloda/GlodaIndexer.sys.mjs"
  );
  const { GlodaDatastore } = ChromeUtils.importESModule(DATASTORE_MODULE);
  const { waitForGlodaDBFlush } = ChromeUtils.importESModule(
    "resource://testing-common/gloda/GlodaTestHelperFunctions.sys.mjs"
  );
  registerCleanupFunction(() => GlodaIndexer._shutdown());
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed(messageSets, { augment: true }));
  Assert.ok(headers.every(header => Gloda.isMessageIndexed(header)));
  await waitForGlodaDBFlush();
  locations = headers.map(header => [header.folder.URI, header.messageKey]);
  originalFiles = [];
  for (const [i, header] of headers.entries()) {
    const folder = header.folder;
    const writer = folder.msgDatabase;
    writer.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
    writer.forceClosed();
    // A folder-bound reader is required for physical header lookup. Preserve an
    // invalid summary rather than allowing the open to delete its source.
    const reader = backend.openFolderDB(folder, true);
    reader.QueryInterface(Ci.nsIMsgOfflineOpsDatabase);
    Assert.notEqual(reader, writer);
    try {
      Assert.equal(
        reader.getMsgHdrForKey(locations[i][1]).messageId,
        "recovery-" + ["plain", "attachment"][i] + "@example.invalid"
      );
    } finally {
      reader.forceClosed();
    }
    for (const file of [folder.summaryFile, folder.filePath]) {
      originalFiles.push([file.path, await IOUtils.read(file.path)]);
    }
  }
  const snapshot = do_get_profile().clone();
  snapshot.append("legacy-recovery.sqlite");
  Assert.ok(!snapshot.exists());
  Assert.ok(!(await IOUtils.exists(snapshot.path + ".tmp")));
  // The backup callback runs after closing and renaming the destination. The
  // original Gloda connection remains open; a flush alone is not a closed copy.
  await new Promise((resolve, reject) => {
    GlodaDatastore.asyncConnection.backupToFileAsync(snapshot, status => {
      if (Components.isSuccessCode(status)) {
        resolve();
      } else {
        reject(Components.Exception("Legacy snapshot backup failed", status));
      }
    });
  });
  Assert.ok(snapshot.isFile());
  Assert.ok(!(await IOUtils.exists(snapshot.path + ".tmp")));
  Assert.ok(GlodaDatastore.syncConnection.connectionReady);
  snapshotPath = snapshot.path;
  originalFiles.push([snapshotPath, await IOUtils.read(snapshotPath)]);
});

add_task(async function test_readsRealLegacyTextAndPhysicalLocations() {
  const recovered = await readLegacyGlodaMail(snapshotPath);
  Assert.equal(recovered.schemaVersion, 30);
  Assert.equal(recovered.messages.length, 2);
  Assert.deepEqual(
    recovered.messages
      .map(message => [message.folderURI, message.messageKey])
      .sort(),
    [...locations].sort()
  );
  for (const [i, name] of ["plain", "attachment"].entries()) {
    const [folderURI, key] = locations[i];
    const message = recovered.messages.find(
      item => item.folderURI == folderURI && item.messageKey == key
    );
    Assert.equal(
      message.headerMessageId,
      "recovery-" + name + "@example.invalid"
    );
    Assert.equal(message.deleted, false);
    Assert.ok(!Object.hasOwn(message, "eligible"));
    Assert.equal(message.text.subject, "Legacy recovery " + name);
    Assert.equal(message.text.body, BODY);
  }
  Assert.equal(
    recovered.messages.find(
      message =>
        message.messageKey == locations[1][1] &&
        message.folderURI == locations[1][0]
    ).text.attachmentNames,
    "recovery.txt"
  );
  const again = await readLegacyGlodaMail(snapshotPath);
  Assert.deepEqual(again, recovered);
  Assert.equal(recovered.source.size, originalFiles.at(-1)[1].length);
  for (const [path, bytes] of originalFiles) {
    const after = await IOUtils.read(path);
    Assert.ok(
      after.length == bytes.length &&
        after.every((byte, index) => byte == bytes[index]),
      "Recovery leaves the source bytes unchanged: " + path
    );
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    Assert.ok(!(await IOUtils.exists(snapshotPath + suffix)));
  }
});

add_task(async function test_preservesRealPlainEncryptionAttribute() {
  const recovered = await readLegacyGlodaMail(snapshotPath);
  const definition = recovered.attributeDefinitions.find(
    row =>
      row.name.value == "isEncrypted" && row.extensionName.value == "built-in"
  );
  Assert.ok(definition, "The real producer records its encryption attribute");
  for (const message of recovered.messages) {
    Assert.equal(message.raw.jsonAttributes.type, "text");
    const attributes = JSON.parse(message.raw.jsonAttributes.value);
    Assert.ok(Object.hasOwn(attributes, definition.id.value));
    Assert.strictEqual(attributes[definition.id.value], false);
    Assert.deepEqual(
      message.attributes.filter(
        attribute => attribute.attributeID.value == definition.id.value
      ),
      [],
      "This singular attribute is preserved in JSON, not invented as a typed row"
    );
  }
});
