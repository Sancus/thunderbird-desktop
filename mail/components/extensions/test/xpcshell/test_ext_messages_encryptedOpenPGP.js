/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

if (typeof encryptedMessageFixtures == "undefined") {
  load("head_ext_messages_encrypted.js");
}

encryptedMessageFixtures = [3];

add_task(async function test_openpgp_enc_msg_inline() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test3" });
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);
        const msgId = messages[0].id;

        // Get the still encrypted mime tree.
        const fullEncrypted = await browser.messages.getFull(msgId, {
          decrypt: false,
        });
        // Check the still encrypted mime tree. Important: decryptionStatus == "skipped".
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: 335,
            decryptionStatus: "skipped",
            headers: {
              "message-id": ["<openpgp.enc.inline@mime.sample>"],
              date: ["Thu, 13 Jun 2024 22:08:14 +0200"],
              "mime-version": ["1.0"],
              to: ["alice@openpgp.example"],
              from: ["bob@openpgp.example"],
              subject: ["OpenPGP inline encrypted"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "text/plain",
                headers: {
                  "content-type": ["text/plain; charset=UTF-8; format=flowed"],
                  "content-transfer-encoding": ["7bit"],
                },
                size: 335,
                partName: "1",
              },
            ],
          },
          fullEncrypted,
          "The still encrypted tree should be correct"
        );

        // Get the raw decrypted content of the message.
        const rawFile = await browser.messages.getRaw(msgId, { decrypt: true });
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(rawFile instanceof File);
        const rawContent = (await rawFile.text())
          .replaceAll("\r\n", "\n")
          .split("\n")
          .filter(line => !line.startsWith("X-Mozilla-Status"));
        window.assertDeepEqual(
          [
            "Message-Id: <openpgp.enc.inline@mime.sample>",
            "Date: Thu, 13 Jun 2024 22:08:14 +0200",
            "Mime-Version: 1.0",
            "To: alice@openpgp.example",
            "From: bob@openpgp.example",
            "Subject: OpenPGP inline encrypted",
            "Content-Type: ",
            "Content-Transfer-Encoding: 8bit",
            "",
            "Somewhere over the rainbow",
            "",
            "",
          ],
          rawContent,
          "getRaw() for the decrypted message should be correct"
        );

        // Get the decrypted mime tree.
        const fullDecrypted = await browser.messages.getFull(msgId);
        // Check the decrypted mime tree. Important: decryptionStatus == "success".
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: 28,
            decryptionStatus: "success",
            headers: {
              "message-id": ["<openpgp.enc.inline@mime.sample>"],
              date: ["Thu, 13 Jun 2024 22:08:14 +0200"],
              "mime-version": ["1.0"],
              to: ["alice@openpgp.example"],
              from: ["bob@openpgp.example"],
              subject: ["OpenPGP inline encrypted"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "text/plain",
                headers: {
                  "content-type": [""],
                  "content-transfer-encoding": ["8bit"],
                },
                size: 28,
                partName: "1",
                body: "Somewhere over the rainbow\n\n",
              },
            ],
          },
          fullDecrypted,
          "The decrypted tree should be correct"
        );

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 3,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});
