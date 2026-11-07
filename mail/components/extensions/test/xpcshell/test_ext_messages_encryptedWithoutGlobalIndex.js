/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from test_ext_messages_encrypted.js */

load("test_ext_messages_encrypted.js");
load("test_ext_messages_encryptedNestedAttachments.js");
load("test_ext_messages_encryptedInnerNested.js");

encryptedMessageFixtures = [1, 3, 4];

add_task(async function test_queryDecryptedBodyWithoutGlobalIndex() {
  Assert.ok(
    !Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled")
  );
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        for (const [name, literal] of [
          ["test3", "Somewhere over the rainbow"],
          ["test4", "This is a test message from Alice to Bob."],
        ]) {
          const [folder] = await browser.folders.query({ name });
          const { messages } = await browser.messages.list(folder.id);
          browser.test.assertEq(1, messages.length);
          const original = messages[0];
          const full = await browser.messages.getFull(original.id);
          browser.test.assertEq("success", full.decryptionStatus);
          for (const field of ["body", "fullText"]) {
            const found = await browser.messages.query({
              folderId: folder.id,
              [field]: literal,
              autoPaginationTimeout: 0,
            });
            window.assertDeepEqual(
              [original.id],
              found.messages.map(m => m.id),
              `${name} ${field} uses actual decrypted MIME`,
              { strict: true }
            );
            const missing = await browser.messages.query({
              folderId: folder.id,
              [field]: "extension101-absent-control",
              autoPaginationTimeout: 0,
            });
            browser.test.assertEq(0, missing.messages.length);
          }
        }
        browser.test.notifyPass("decrypted-query");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  await extension.startup();
  await extension.awaitFinish("decrypted-query");
  await extension.unload();
});
