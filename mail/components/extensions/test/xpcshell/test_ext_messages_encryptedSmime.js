/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

load("head_ext_messages_encrypted.js");

add_task(async function test_smime_enc_not_signed() {
  const enc = await readSmimeExpectations("alice.env.eml");
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "expected.js": `window.SMIME = ${JSON.stringify({
        date: enc.date,
        encSize: enc.derSize,
      })};`,
      "background.js": async () => {
        const { date, encSize } = window.SMIME;
        const [folder] = await browser.folders.query({ name: "test4" });
        const { accountId } = folder;
        const { type } = await browser.accounts.get(accountId);

        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);
        const msgId = messages[0].id;

        // Get the still encrypted tree. It should be marked as encrypted but not
        // decrypted (decryptionStatus = skipped).
        const fullEncrypted = await browser.messages.getFull(msgId, {
          decrypt: false,
        });
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: encSize,
            decryptionStatus: "skipped",
            headers: {
              "mime-version": ["1.0"],
              date: [date],
              from: ["Alice@example.com"],
              to: ["Bob@example.com"],
              subject: ["enveloped"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "application/pkcs7-mime",
                headers: {
                  "content-type": [
                    "application/pkcs7-mime; name=smime.p7m;    smime-type=enveloped-data",
                  ],
                  "content-transfer-encoding": ["base64"],
                  "content-disposition": ["attachment; filename=smime.p7m"],
                  "content-description": ["S/MIME Encrypted Message"],
                },
                size: encSize,
                partName: "1",
                name: "smime.p7m",
              },
            ],
          },
          fullEncrypted,
          "getFull() for the encrypted message should be correct"
        );

        // Get the raw decrypted content of the message.
        const rawFile = await browser.messages.getRaw(msgId, { decrypt: true });
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(rawFile instanceof File);
        browser.test.assertEq(type == "imap" ? 359 : 306, rawFile.size);
        const rawContent = (await rawFile.text())
          .replaceAll("\r\n", "\n")
          .split("\n")
          .filter(line => !line.startsWith("X-Mozilla-Status"));
        window.assertDeepEqual(
          [
            "Message-Id: <test4@sample.message>",
            "Mime-Version: 1.0",
            `Date: ${date}`,
            "From: Alice@example.com",
            "To: Bob@example.com",
            "Subject: enveloped",
            "Content-Type: text/plain; charset=utf-8; format=flowed",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "This is a test message from Alice to Bob.",
            "",
          ],
          rawContent,
          "getRaw() for the decrypted message should be correct"
        );

        // Get the full decrypted content of the message.
        const fullDecrypted = await browser.messages.getFull(msgId, {
          decrypt: true,
        });
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: 43,
            decryptionStatus: "success",
            headers: {
              "mime-version": ["1.0"],
              date: [date],
              from: ["Alice@example.com"],
              to: ["Bob@example.com"],
              subject: ["enveloped"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "text/plain",
                headers: {
                  "content-type": ["text/plain; charset=utf-8; format=flowed"],
                  "content-transfer-encoding": ["quoted-printable"],
                },
                size: 43,
                partName: "1",
                body: "This is a test message from Alice to Bob.\r\n",
              },
            ],
          },
          fullDecrypted,
          "getFull() for the decrypted message should be correct"
        );

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 3,
      background: { scripts: ["utils.js", "expected.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function test_smime_enc_signed() {
  const enc = await readSmimeExpectations("alice.sig.SHA256.opaque.env.eml");
  const dec = await readSmimeExpectations("alice.sig.SHA256.opaque.eml");
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "expected.js": `window.SMIME = ${JSON.stringify({
        date: enc.date,
        encSize: enc.derSize,
        decSize: dec.derSize,
        signedBlockLines: dec.bodyLines,
      })};`,
      "background.js": async () => {
        const { date, encSize, decSize, signedBlockLines } = window.SMIME;
        const [folder] = await browser.folders.query({ name: "test5" });
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);
        const msgId = messages[0].id;

        // Get the still encrypted tree. It should be marked as encrypted but not
        // decrypted (decryptionStatus = skipped).
        const fullEncrypted = await browser.messages.getFull(msgId, {
          decrypt: false,
        });
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: encSize,
            decryptionStatus: "skipped",
            headers: {
              "mime-version": ["1.0"],
              date: [date],
              from: ["Alice@example.com"],
              to: ["Bob@example.com"],
              subject: ["opaque-signed then enveloped sig.SHA256"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "application/pkcs7-mime",
                headers: {
                  "content-type": [
                    "application/pkcs7-mime; name=smime.p7m;    smime-type=enveloped-data",
                  ],
                  "content-transfer-encoding": ["base64"],
                  "content-disposition": ["attachment; filename=smime.p7m"],
                  "content-description": ["S/MIME Encrypted Message"],
                },
                size: encSize,
                partName: "1",
                name: "smime.p7m",
              },
            ],
          },
          fullEncrypted,
          "getFull() for the encrypted message should be correct"
        );

        // Get the raw decrypted content of the message.
        const rawBinaryString = await browser.messages.getRaw(msgId, {
          data_format: "BinaryString",
          decrypt: true,
        });
        const rawContent = rawBinaryString
          .replaceAll("\r\n", "\n")
          .split("\n")
          .filter(line => !line.startsWith("X-Mozilla-Status"));
        window.assertDeepEqual(
          [
            "Message-Id: <test5@sample.message>",
            "Mime-Version: 1.0",
            `Date: ${date}`,
            "From: Alice@example.com",
            "To: Bob@example.com",
            "Subject: opaque-signed then enveloped sig.SHA256",
            "Content-Type: application/pkcs7-mime; name=smime.p7m;    smime-type=signed-data",
            "Content-Transfer-Encoding: base64",
            "Content-Disposition: attachment; filename=smime.p7m",
            "Content-Description: S/MIME Cryptographic Signature",
            "",
            ...signedBlockLines,
            "",
          ],
          rawContent,
          "getRaw() for the decrypted message should be correct"
        );

        // Get the full decrypted content of the message.
        const fullDecrypted = await browser.messages.getFull(msgId, {
          decrypt: true,
        });
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: decSize,
            decryptionStatus: "success",
            headers: {
              "mime-version": ["1.0"],
              date: [date],
              from: ["Alice@example.com"],
              to: ["Bob@example.com"],
              subject: ["opaque-signed then enveloped sig.SHA256"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "application/pkcs7-mime",
                headers: {
                  "content-type": [
                    "application/pkcs7-mime; name=smime.p7m;    smime-type=signed-data",
                  ],
                  "content-transfer-encoding": ["base64"],
                  "content-disposition": ["attachment; filename=smime.p7m"],
                  "content-description": ["S/MIME Cryptographic Signature"],
                },
                size: decSize,
                partName: "1",
                name: "smime.p7m",
              },
            ],
          },
          fullDecrypted,
          "getFull() for the decrypted message should be correct"
        );

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 3,
      background: { scripts: ["utils.js", "expected.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();
});

add_task(async function deleteAttachments_smime() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test5" });
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);
        const msgId = messages[0].id;

        const attachments = await browser.messages.listAttachments(msgId);
        browser.test.assertEq(
          1,
          attachments.length,
          "Should find the correct number of attachments"
        );
        browser.test.assertEq(
          "1",
          attachments[0].partName,
          "Should find the correct partName for attachment #1"
        );

        await browser.test.assertRejects(
          browser.messages.deleteAttachments(msgId, ["1"]),
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
