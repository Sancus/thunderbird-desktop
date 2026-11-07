/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

if (typeof encryptedMessageFixtures == "undefined") {
  load("head_ext_messages_encrypted.js");
}

encryptedMessageFixtures = [1];

add_task(async function deleteAttachments_openpgp_enc_nested_messages() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test1" });
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);
        const msgId = messages[0].id;

        const attachments = await browser.messages.listAttachments(msgId);
        browser.test.assertEq(
          2,
          attachments.length,
          "Should find the correct number of attachments"
        );
        browser.test.assertEq(
          "1.1.2",
          attachments[0].partName,
          "Should find the correct partName for attachment #1"
        );
        browser.test.assertEq(
          "1.1.3",
          attachments[1].partName,
          "Should find the correct partName for attachment #2"
        );

        await browser.test.assertRejects(
          browser.messages.deleteAttachments(msgId, ["1.1.2"]),
          /Operation not supported for encrypted messages/,
          "Should reject deleting attachments of encrypted messages"
        );

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 3,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead", "messagesModifyPermanent"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});
