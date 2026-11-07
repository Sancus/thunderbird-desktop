/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

if (typeof encryptedMessageFixtures == "undefined") {
  load("head_ext_messages_encrypted.js");
}

encryptedMessageFixtures = [1];

add_task(async function test_openpgp_enc_inner_nested_message() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test1" });
        const { messages } = await browser.messages.list(folder.id);
        // Resolve both ancestors through the actual messages API so the inner
        // external header has the same physical identity as in the outer test.
        await browser.messages.listAttachments(messages[0].id);
        await browser.messages.listAttachments(2);
        const files = new Map();
        const file15content = await (
          await browser.messages.getAttachmentFile(2, "1.5")
        ).text();

        // Get the raw content of the inner nested message (part 1.5, id: 3) via
        // getRaw().
        const raw3file = await browser.messages.getRaw(3);
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(raw3file instanceof File);
        browser.test.assertEq("message-3.eml", raw3file.name);
        browser.test.assertEq(838, raw3file.size);
        const raw3content = await raw3file.text();
        browser.test.assertEq(
          raw3content,
          file15content,
          "getRaw() of the inner attached message and getAttachmentFile() of the inner attached message should be identical"
        );

        // Get the full content of the inner nested message via getFull().
        const full3 = await browser.messages.getFull(3);
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: 100,
            decryptionStatus: "none",
            headers: {
              "message-id": ["<sample-nested-attached.eml@mime.sample>"],
              from: ["Jimmy <jimmy.olsen@dailyplanet.com>"],
              to: ["Superman <clark.kent@dailyplanet.com>"],
              subject: ["Test message 2"],
              date: ["Wed, 16 May 2000 19:32:47 -0400"],
              "mime-version": ["1.0"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "multipart/mixed",
                headers: {
                  "content-type": [
                    'multipart/mixed;  boundary="----=_NextPart_000_0003_01BFC036.AE309650"',
                  ],
                },
                size: 100,
                partName: "1",
                parts: [
                  {
                    contentType: "text/plain",
                    headers: {
                      "content-type": ['text/plain;  charset="iso-8859-1"'],
                      "content-transfer-encoding": ["7bit"],
                    },
                    size: 31,
                    partName: "1.1",
                    body: "This message has an attachment\n",
                  },
                  {
                    contentType: "image/png",
                    headers: {
                      "content-type": ['image/png;  name="whitePixel.png"'],
                      "content-transfer-encoding": ["base64"],
                      "content-disposition": [
                        'attachment;  filename="whitePixel.png"',
                      ],
                    },
                    size: 69,
                    partName: "1.2",
                    name: "whitePixel.png",
                  },
                ],
              },
            ],
          },
          full3,
          "getFull() of the inner nested message should be correct"
        );

        // List the attachments from the inner nested message.
        const attachments3 = await browser.messages.listAttachments(3);
        window.assertDeepEqual(
          [
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "image/png",
              headers: {
                "content-type": ['image/png;  name="whitePixel.png"'],
                "content-transfer-encoding": ["base64"],
                "content-disposition": [
                  'attachment;  filename="whitePixel.png"',
                ],
              },
              name: "whitePixel.png",
              partName: "1.2",
              size: 69,
            },
          ],
          attachments3,
          "Attachments of the inner nested message should be correct",
          {
            strict: true,
          }
        );

        // Get the actual attachments of the inner nested message as File objects.
        const expectedAttachments3 = [
          {
            name: "whitePixel.png",
            size: 69,
            partName: "1.2",
          },
        ];
        for (const expectedAttachment3 of expectedAttachments3) {
          const f = await browser.messages.getAttachmentFile(
            3,
            expectedAttachment3.partName
          );
          files.set(expectedAttachment3.partName, f);
          // eslint-disable-next-line mozilla/use-isInstance
          browser.test.assertTrue(f instanceof File);
          browser.test.assertEq(
            expectedAttachment3.name,
            f.name,
            `Name of part ${expectedAttachment3.partName} should be correct`
          );
          browser.test.assertEq(
            expectedAttachment3.size,
            f.size,
            `Size of part ${expectedAttachment3.partName} should be correct`
          );
        }

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
