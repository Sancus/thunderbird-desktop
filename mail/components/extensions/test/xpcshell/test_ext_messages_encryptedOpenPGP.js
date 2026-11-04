/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

load("head_ext_messages_encrypted.js");

encryptedMessageFixtures = [1, 2, 3];

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

add_task(async function test_openpgp_enc_msg_attachment() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test2" });
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
            size: 372,
            decryptionStatus: "skipped",
            headers: {
              date: ["Tue, 11 Jun 2024 10:15:42 +0200"],
              "mime-version": ["1.0"],
              from: ["bob@openpgp.example"],
              to: ["alice@openpgp.example"],
              subject: ["message with encrypted attachment"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "multipart/mixed",
                headers: {
                  "content-type": [
                    'multipart/mixed; boundary="------------FGUqlZlVFriqCYaAUQpdbRZu"',
                  ],
                  "content-language": ["en-US"],
                },
                size: 372,
                partName: "1",
                parts: [
                  {
                    contentType: "text/plain",
                    headers: {
                      "content-type": [
                        "text/plain; charset=UTF-8; format=flowed",
                      ],
                      "content-transfer-encoding": ["7bit"],
                    },
                    size: 46,
                    partName: "1.1",
                    body: "Hello Alice, the encrypted file is attached.\r\n",
                  },
                  {
                    contentType: "text/plain",
                    headers: {
                      "content-type": [
                        'text/plain; charset=UTF-8; name="encrypted-attachment.txt.asc"',
                      ],
                      "content-disposition": [
                        'attachment; filename="encrypted-attachment.txt.asc"',
                      ],
                      "content-transfer-encoding": ["base64"],
                    },
                    size: 326,
                    partName: "1.2",
                    name: "encrypted-attachment.txt.asc",
                  },
                ],
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
            "Message-Id: <openpgp.enc.attachment@mime.sample>",
            'Content-Type: multipart/mixed; boundary="------------FGUqlZlVFriqCYaAUQpdbRZu"',
            "Date: Tue, 11 Jun 2024 10:15:42 +0200",
            "Mime-Version: 1.0",
            "From: bob@openpgp.example",
            "Content-Language: en-US",
            "To: alice@openpgp.example",
            "Subject: message with encrypted attachment",
            "",
            "--------------FGUqlZlVFriqCYaAUQpdbRZu",
            "Content-Type: text/plain; charset=UTF-8; format=flowed",
            "Content-Transfer-Encoding: 7bit",
            "",
            "Hello Alice, the encrypted file is attached.",
            "",
            "--------------FGUqlZlVFriqCYaAUQpdbRZu",
            'Content-Type: text/plain; charset="UTF-8"; name="encrypted-attachment.txt"',
            'Content-Disposition: attachment; filename="encrypted-attachment.txt"',
            "Content-Transfer-Encoding: base64",
            "",
            "VW5pY29ybi1QYXJ0eQo=",
            "",
            "--------------FGUqlZlVFriqCYaAUQpdbRZu--",
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
            size: 60,
            decryptionStatus: "success",
            headers: {
              date: ["Tue, 11 Jun 2024 10:15:42 +0200"],
              "mime-version": ["1.0"],
              from: ["bob@openpgp.example"],
              to: ["alice@openpgp.example"],
              subject: ["message with encrypted attachment"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "multipart/mixed",
                headers: {
                  "content-type": [
                    'multipart/mixed; boundary="------------FGUqlZlVFriqCYaAUQpdbRZu"',
                  ],
                  "content-language": ["en-US"],
                },
                size: 60,
                partName: "1",
                parts: [
                  {
                    contentType: "text/plain",
                    headers: {
                      "content-type": [
                        "text/plain; charset=UTF-8; format=flowed",
                      ],
                      "content-transfer-encoding": ["7bit"],
                    },
                    size: 46,
                    partName: "1.1",
                    body: "Hello Alice, the encrypted file is attached.\r\n",
                  },
                  {
                    contentType: "text/plain",
                    headers: {
                      "content-type": [
                        'text/plain; charset="UTF-8"; name="encrypted-attachment.txt"',
                      ],
                      "content-disposition": [
                        'attachment; filename="encrypted-attachment.txt"',
                      ],
                      "content-transfer-encoding": ["base64"],
                    },
                    size: 14,
                    partName: "1.2",
                    name: "encrypted-attachment.txt",
                  },
                ],
              },
            ],
          },
          fullDecrypted,
          "The decrypted tree should be correct"
        );

        // List the decrypted attachments.
        const attachments = await browser.messages.listAttachments(msgId);
        window.assertDeepEqual(
          [
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "text/plain",
              headers: {
                "content-type": [
                  'text/plain; charset="UTF-8"; name="encrypted-attachment.txt"',
                ],
                "content-disposition": [
                  'attachment; filename="encrypted-attachment.txt"',
                ],
                "content-transfer-encoding": ["base64"],
              },
              name: "encrypted-attachment.txt",
              partName: "1.2",
              size: 14,
            },
          ],
          attachments,
          "The decrypted attachments should be correct",
          { strict: true }
        );

        // Get the decrypted attachment.
        const file12 = await browser.messages.getAttachmentFile(msgId, "1.2");
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(file12 instanceof File);
        browser.test.assertEq(14, file12.size);
        const content12 = await file12.text();
        browser.test.assertEq(
          "Unicorn-Party",
          content12.trim(),
          "content12 should be correct"
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
