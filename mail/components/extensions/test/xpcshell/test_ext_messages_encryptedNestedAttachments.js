/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_ext_messages_encrypted.js */

if (typeof encryptedMessageFixtures == "undefined") {
  load("head_ext_messages_encrypted.js");
}

encryptedMessageFixtures = [1];

add_task(async function test_openpgp_enc_nested_message_attachments() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [folder] = await browser.folders.query({ name: "test1" });
        const { messages } = await browser.messages.list(folder.id);
        // Materialize the same external message identity before checking it.
        await browser.messages.listAttachments(messages[0].id);
        const file112 = await browser.messages.getAttachmentFile(1, "1.1.2");
        const file112content = await file112.text();

        // Get the raw content of the nested message (id: 2) via getRaw().
        const raw2file = await browser.messages.getRaw(2);
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(raw2file instanceof File);
        browser.test.assertEq("message-2.eml", raw2file.name);
        browser.test.assertEq(2517, raw2file.size);
        const raw2content = await raw2file.text();
        browser.test.assertEq(
          raw2content,
          file112content,
          "getRaw() of the attached message and getAttachmentFile() of the attached message should be identical"
        );

        // Get the full content of the nested message via getFull().
        const full2 = await browser.messages.getFull(2);
        window.assertDeepEqual(
          {
            contentType: "message/rfc822",
            partName: "",
            size: 1180,
            decryptionStatus: "none",
            headers: {
              "message-id": ["<sample-attached.eml@mime.sample>"],
              from: ["Superman <clark.kent@dailyplanet.com>"],
              to: ["Jimmy <jimmy.olsen@dailyplanet.com>"],
              subject: ["Test message 1"],
              date: ["Wed, 17 May 2000 19:32:47 -0400"],
              "mime-version": ["1.0"],
              "content-type": ["message/rfc822"],
            },
            parts: [
              {
                contentType: "multipart/mixed",
                headers: {
                  "content-type": [
                    'multipart/mixed;\tboundary="----=_NextPart_000_0002_01BFC036.AE309650"',
                  ],
                },
                size: 1180,
                partName: "1",
                parts: [
                  {
                    contentType: "text/plain",
                    headers: {
                      "content-type": ['text/plain;\tcharset="iso-8859-1"'],
                      "content-transfer-encoding": ["7bit"],
                    },
                    size: 35,
                    partName: "1.1",
                    body: "Message with multiple attachments.\n",
                  },
                  {
                    contentType: "image/png",
                    headers: {
                      "content-type": ['image/png;\tname="whitePixel.png"'],
                      "content-transfer-encoding": ["base64"],
                      "content-disposition": [
                        'attachment;\tfilename="whitePixel.png"',
                      ],
                    },
                    size: 69,
                    partName: "1.2",
                    name: "whitePixel.png",
                  },
                  {
                    contentType: "image/png",
                    headers: {
                      "content-type": ['image/png;\tname="greenPixel.png"'],
                      "content-transfer-encoding": ["base64"],
                      "content-disposition": ["attachment"],
                    },
                    size: 119,
                    partName: "1.3",
                    name: "greenPixel.png",
                  },
                  {
                    contentType: "image/png",
                    headers: {
                      "content-type": ["image/png"],
                      "content-transfer-encoding": ["base64"],
                      "content-disposition": [
                        'attachment;\tfilename="redPixel.png"',
                      ],
                    },
                    size: 119,
                    partName: "1.4",
                    name: "redPixel.png",
                  },
                  {
                    contentType: "message/rfc822",
                    headers: {
                      "content-type": [
                        'message/rfc822; charset=UTF-8; name="message2.eml"',
                      ],
                      "content-disposition": [
                        'attachment; filename="message2.eml"',
                      ],
                      "content-transfer-encoding": ["7bit"],
                    },
                    size: 838,
                    partName: "1.5",
                    name: "message2.eml",
                  },
                ],
              },
            ],
          },
          full2,
          "getFull() of the nested message should be correct"
        );

        // List the attachments from the nested message.
        const attachments2 = await browser.messages.listAttachments(2);
        window.assertDeepEqual(
          [
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "image/png",
              headers: {
                "content-type": ['image/png;\tname="whitePixel.png"'],
                "content-transfer-encoding": ["base64"],
                "content-disposition": [
                  'attachment;\tfilename="whitePixel.png"',
                ],
              },
              name: "whitePixel.png",
              partName: "1.2",
              size: 69,
            },
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "image/png",
              headers: {
                "content-type": ['image/png;\tname="greenPixel.png"'],
                "content-transfer-encoding": ["base64"],
                "content-disposition": ["attachment"],
              },
              name: "greenPixel.png",
              partName: "1.3",
              size: 119,
            },
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "image/png",
              headers: {
                "content-type": ["image/png"],
                "content-transfer-encoding": ["base64"],
                "content-disposition": ['attachment;\tfilename="redPixel.png"'],
              },
              name: "redPixel.png",
              partName: "1.4",
              size: 119,
            },
            {
              contentDisposition: "attachment",
              type: "normal",
              contentType: "message/rfc822",
              headers: {
                "content-type": [
                  'message/rfc822; charset=UTF-8; name="message2.eml"',
                ],
                "content-disposition": ['attachment; filename="message2.eml"'],
                "content-transfer-encoding": ["7bit"],
              },
              name: "message2.eml",
              partName: "1.5",
              size: 100,
              message: {
                id: 3,
                date: new Date("2000-05-16T23:32:47.000Z"),
                author: "Jimmy <jimmy.olsen@dailyplanet.com>",
                recipients: ["Superman <clark.kent@dailyplanet.com>"],
                ccList: [],
                bccList: [],
                subject: "Test message 2",
                read: false,
                new: false,
                headersOnly: false,
                flagged: false,
                junk: false,
                junkScore: 0,
                headerMessageId: "sample-nested-attached.eml@mime.sample",
                size: 100,
                tags: [],
                external: true,
                priority: "none",
              },
            },
          ],
          attachments2,
          "Attachments of the nested message should be correct",
          {
            strict: true,
          }
        );

        // Get the actual attachments of the nested message as File objects.
        const files = new Map();
        const expectedAttachments2 = [
          {
            name: "whitePixel.png",
            size: 69,
            partName: "1.2",
          },
          {
            name: "greenPixel.png",
            size: 119,
            partName: "1.3",
          },
          {
            name: "redPixel.png",
            size: 119,
            partName: "1.4",
          },
          {
            name: "message2.eml",
            size: 838,
            partName: "1.5",
          },
        ];
        for (const expectedAttachment2 of expectedAttachments2) {
          const f = await browser.messages.getAttachmentFile(
            2,
            expectedAttachment2.partName
          );
          files.set(expectedAttachment2.partName, f);
          // eslint-disable-next-line mozilla/use-isInstance
          browser.test.assertTrue(f instanceof File);
          browser.test.assertEq(
            expectedAttachment2.name,
            f.name,
            `Name of part ${expectedAttachment2.partName} should be correct`
          );
          browser.test.assertEq(
            expectedAttachment2.size,
            f.size,
            `Size of part ${expectedAttachment2.partName} should be correct`
          );
        }

        // Check content of the inner nested message (part 1.5, id: 3).
        const file15content = await files.get("1.5").text();
        browser.test.assertTrue(
          !file15content.includes("<sample.eml@mime.sample>"),
          "file15content should not include the message ID of the outer message"
        );
        browser.test.assertTrue(
          !file15content.includes("<sample-attached.eml@mime.sample>"),
          "file15content should not include the message ID of the nested message"
        );
        browser.test.assertTrue(
          file15content.includes("<sample-nested-attached.eml@mime.sample>"),
          "file15content should include the message ID of the inner nested message"
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
