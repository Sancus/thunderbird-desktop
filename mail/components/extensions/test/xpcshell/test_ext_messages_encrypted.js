/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

if (typeof encryptedMessageFixtures == "undefined") {
  load("head_ext_messages_encrypted.js");
}

encryptedMessageFixtures = [1];

add_task(async function test_openpgp_enc_nested_messages() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test1" });
        const { accountId } = folder;
        const { type } = await browser.accounts.get(accountId);

        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);
        browser.test.assertEq(1, messages[0].id);

        // Get the still encrypted tree. It should be marked as encrypted but not
        // decrypted (decryptionStatus = skipped).
        const fullEncrypted = await browser.messages.getFull(1, {
          decrypt: false,
        });
        browser.test.assertEq(
          "skipped",
          fullEncrypted.decryptionStatus,
          "The decryptionStatus should be correct"
        );

        // Get the raw decrypted content of the message (id: 1) via getRaw().
        const raw1file = await browser.messages.getRaw(1, { decrypt: true });
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(raw1file instanceof File);
        browser.test.assertEq("message-1.eml", raw1file.name);
        browser.test.assertEq(type == "imap" ? 4024 : 3971, raw1file.size);
        const raw1content = await raw1file.text();
        browser.test.assertTrue(
          !raw1content.includes("-----BEGIN PGP MESSAGE-----"),
          "getRaw() of the outer message should be decrypted"
        );
        browser.test.assertTrue(
          raw1content.includes("<sample.eml@mime.sample>"),
          "getRaw() of the outer message should include the message ID of the outer message"
        );
        browser.test.assertTrue(
          raw1content.includes("<sample-attached.eml@mime.sample>"),
          "getRaw() of the outer message should include the message ID of the nested message"
        );
        browser.test.assertTrue(
          raw1content.includes("<sample-nested-attached.eml@mime.sample>"),
          "getRaw() of the outer message should include the message ID of the inner nested message"
        );

        // Get the full decrypted content of the message (id: 1) via getFull().
        const full1 = await browser.messages.getFull(1, { decrypt: true });
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: 2884,
            decryptionStatus: "success",
            headers: {
              "message-id": ["<sample.eml@mime.sample>"],
              date: ["Fri, 20 May 2000 00:29:55 -0400"],
              to: ["Alice Lovelace <alice@openpgp.example>"],
              from: ["Batman <bruce@wayne-enterprises.com>"],
              subject: ["Encrypted, attached message with attachments"],
              "mime-version": ["1.0"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "multipart/mixed",
                headers: {
                  "content-type": [
                    'multipart/mixed; boundary="------------M20GNGI1rLZhtbYD7WFekIXJ"',
                  ],
                },
                size: 2884,
                partName: "1",
                parts: [
                  {
                    contentType: "multipart/mixed",
                    headers: {
                      "content-type": [
                        'multipart/mixed;   boundary="------------49CVLb1N6p6Spdka4qq7Naeg"',
                      ],
                    },
                    size: 2884,
                    partName: "1.1",
                    parts: [
                      {
                        contentType: "text/html",
                        headers: {
                          "content-type": ["text/html; charset=UTF-8"],
                          "content-transfer-encoding": ["7bit"],
                        },
                        size: 248,
                        partName: "1.1.1",
                        body: '<html>\n  <head>\n\n    <meta http-equiv="content-type" content="text/html; charset=UTF-8">\n  </head>\n  <body>\n    <p>This message has one normal attachment and one email attachment,\n      which itself has 3 attachments.<br>\n    </p>\n  </body>\n</html>',
                      },
                      {
                        contentType: "message/rfc822",
                        headers: {
                          "content-type": [
                            'message/rfc822; charset=UTF-8; name="message1.eml"',
                          ],
                          "content-disposition": [
                            'attachment; filename="message1.eml"',
                          ],
                          "content-transfer-encoding": ["7bit"],
                        },
                        size: 2517,
                        partName: "1.1.2",
                        name: "message1.eml",
                      },
                      {
                        contentType: "image/png",
                        headers: {
                          "content-type": ["image/png;"],
                          "content-transfer-encoding": ["base64"],
                          "content-disposition": [
                            'attachment;  filename="yellowPixel.png"',
                          ],
                        },
                        size: 119,
                        partName: "1.1.3",
                        name: "yellowPixel.png",
                      },
                    ],
                  },
                ],
              },
            ],
          },
          full1,
          "getFull() for the outer message should be correct"
        );

        // List the attachments from the decrypted outer message.
        // Note: listAttachments() is always acting on the decrypted message.
        const attachments1 = await browser.messages.listAttachments(1);
        window.assertDeepEqual(
          [
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "message/rfc822",
              headers: {
                "content-type": [
                  'message/rfc822; charset=UTF-8; name="message1.eml"',
                ],
                "content-disposition": ['attachment; filename="message1.eml"'],
                "content-transfer-encoding": ["7bit"],
              },
              name: "message1.eml",
              partName: "1.1.2",
              size: 442,
              message: {
                id: 2,
                date: new Date("2000-05-17T23:32:47.000Z"),
                author: "Superman <clark.kent@dailyplanet.com>",
                recipients: ["Jimmy <jimmy.olsen@dailyplanet.com>"],
                ccList: [],
                bccList: [],
                subject: "Test message 1",
                read: false,
                new: false,
                headersOnly: false,
                flagged: false,
                junk: false,
                junkScore: 0,
                headerMessageId: "sample-attached.eml@mime.sample",
                size: 442,
                tags: [],
                external: true,
                priority: "none",
              },
            },
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "image/png",
              headers: {
                "content-type": ["image/png;"],
                "content-transfer-encoding": ["base64"],
                "content-disposition": [
                  'attachment;  filename="yellowPixel.png"',
                ],
              },
              name: "yellowPixel.png",
              partName: "1.1.3",
              size: 119,
            },
          ],
          attachments1,
          "Attachments of the outer message should be correct",
          {
            strict: true,
          }
        );

        // Get the actual attachments of the outer message as File objects.
        // Note: getAttachmentFile() is always acting on the decrypted message.
        const file112 = await browser.messages.getAttachmentFile(1, "1.1.2");
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(file112 instanceof File);
        browser.test.assertEq("message1.eml", file112.name);
        browser.test.assertEq(2517, file112.size);
        const file112content = await file112.text();
        browser.test.assertTrue(
          !file112content.includes("<sample.eml@mime.sample>"),
          "file112content should not include the message ID of the outer message"
        );
        browser.test.assertTrue(
          file112content.includes("<sample-attached.eml@mime.sample>"),
          "file112content should include the message ID of the nested message"
        );
        browser.test.assertTrue(
          file112content.includes("<sample-nested-attached.eml@mime.sample>"),
          "file112content should include the message ID of the inner nested message"
        );

        const file113 = await browser.messages.getAttachmentFile(1, "1.1.3");
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(file113 instanceof File);
        browser.test.assertEq("yellowPixel.png", file113.name);
        browser.test.assertEq(119, file113.size);

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
