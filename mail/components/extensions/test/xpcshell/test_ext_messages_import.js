/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
var { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

add_setup(async () => {
  registerCleanupFunction(() => {
    // Return to online mode at the end of the test.
    Services.io.offline = true;
  });
});

add_task(async function test_import() {
  const _account = await createAccount();
  await createSubfolder(_account.incomingServer.rootFolder, "test1-offline");
  await createSubfolder(_account.incomingServer.rootFolder, "test2-offline");
  await createSubfolder(_account.incomingServer.rootFolder, "test3-offline");
  await createSubfolder(_account.incomingServer.rootFolder, "test1-online");
  await createSubfolder(_account.incomingServer.rootFolder, "test2-online");
  await createSubfolder(_account.incomingServer.rootFolder, "test3-online");

  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        async function do_import(expected, file, folder, options) {
          const msg = await browser.messages.import(file, folder.id, options);
          browser.test.assertEq(
            "alternative.eml@mime.sample",
            msg.headerMessageId,
            "should find the correct message after import"
          );
          const { messages } = await browser.messages.list(folder.id);
          browser.test.assertEq(
            1,
            messages.length,
            "should find the imported message in the destination folder"
          );
          for (const [propName, value] of Object.entries(expected)) {
            window.assertDeepEqual(
              value,
              messages[0][propName],
              `Property ${propName} should be correct`
            );
          }
        }

        for (const mode of ["offline", "online"]) {
          await window.sendMessage("toggleOfflineMode", mode);

          const accounts = await browser.accounts.list();
          browser.test.assertEq(1, accounts.length);
          const [account] = accounts;

          const folder1 = account.folders.find(f => f.name == `test1-${mode}`);
          const folder2 = account.folders.find(f => f.name == `test2-${mode}`);
          const folder3 = account.folders.find(f => f.name == `test3-${mode}`);
          browser.test.assertTrue(folder1, "Test folder should exist");
          browser.test.assertTrue(folder2, "Test folder should exist");
          browser.test.assertTrue(folder3, "Test folder should exist");

          const [emlFileContent] = await window.sendMessage(
            "getFileContent",
            "messages/alternative.eml"
          );
          const file = new File([emlFileContent], "test.eml");

          if (account.type == "nntp") {
            await browser.test.assertRejects(
              browser.messages.import(file, folder1.id),
              `messages.import() is not supported for ${account.type} accounts`,
              "Should throw for unsupported accounts"
            );
          } else {
            await do_import(
              {
                new: false,
                read: false,
                flagged: false,
              },
              file,
              folder1
            );
            await do_import(
              {
                // FIXME: Setting new is currently broken in IMAP offline mode.
                new: !(mode == "offline" && account.type == "imap"),
                read: false,
                flagged: false,
                tags: ["$label1"],
              },
              file,
              folder2,
              {
                new: !(mode == "offline" && account.type == "imap"),
                read: false,
                flagged: false,
                tags: ["$label1"],
              }
            );
            await do_import(
              {
                new: false,
                read: true,
                flagged: true,
              },
              file,
              folder3,
              {
                read: true,
                flagged: true,
              }
            );
            await browser.test.assertRejects(
              browser.messages.import(file, folder3.id),
              `Error importing message: Destination folder already contains a message with id <alternative.eml@mime.sample>`,
              "Import the same file into the same folder again should fail."
            );
          }
        }

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead", "messagesImport"],
    },
  });

  extension.onMessage("getFileContent", async path => {
    const raw = await IOUtils.read(do_get_file(path).path);
    extension.sendMessage(MailStringUtils.uint8ArrayToByteString(raw));
  });

  extension.onMessage("toggleOfflineMode", async mode => {
    Services.io.offline = mode == "offline";
    extension.sendMessage();
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();

  cleanUpAccount(_account);
});

add_task(
  { skip_if: () => IS_NNTP },
  async function test_importPublishesExactBytesAndRecovers() {
    const account = await createAccount(undefined, {
      extensions: ["RFC2195", "RFC4315"],
    });
    const folder = await createSubfolder(
      account.incomingServer.rootFolder,
      "physicalImport"
    );
    await createMessageFromString(
      folder,
      [
        "From: old@example.invalid",
        "Subject: Existing physical message",
        "Message-ID: <outside-import@example.invalid>",
        "",
        "Unrelated stored bytes",
        "",
      ].join("\r\n")
    );
    const extension = ExtensionTestUtils.loadExtension({
      manifest: {
        manifest_version: 2,
        permissions: ["accountsRead", "messagesRead", "messagesImport"],
      },
      background: async () => {
        const [folder] = await browser.folders.query({
          name: "physicalImport",
        });
        const before = (await browser.messages.list(folder.id)).messages[0];
        const raw = [
          "From: sender@example.invalid",
          "To: recipient@example.invalid",
          "Subject: Imported literal bytes",
          "Message-ID: <selected-import@example.invalid>",
          "",
          "Literal body # retains %23 and the final suffix",
          "",
        ].join("\r\n");
        const file = new File([raw], "physical-import.eml");
        const imported = await browser.messages.import(file, folder.id, {
          read: true,
          flagged: true,
        });
        browser.test.assertTrue(imported.id != before.id);
        browser.test.assertEq(folder.id, imported.folder.id);
        browser.test.assertEq(
          "selected-import@example.invalid",
          imported.headerMessageId
        );
        browser.test.assertTrue(imported.read && imported.flagged);
        browser.test.assertTrue(
          (await browser.messages.getRaw(imported.id)).includes(
            "Literal body # retains %23 and the final suffix"
          ),
          "Actual APPEND readback preserves bytes after # and percent characters"
        );
        await browser.test.assertRejects(
          browser.messages.import(file, folder.id),
          /already contains a message/,
          "Duplicate import preserves its actual error"
        );
        browser.test.assertEq(
          2,
          (await browser.messages.list(folder.id)).messages.length,
          "Failed import adds no extra physical message"
        );
        const next = new File(
          [raw.replaceAll("selected-import", "recovered-import")],
          "recovered.eml"
        );
        const recovered = await browser.messages.import(next, folder.id);
        browser.test.assertTrue(recovered.id != imported.id);
        browser.test.assertEq(
          "recovered-import@example.invalid",
          recovered.headerMessageId
        );
        browser.test.assertEq(
          3,
          (await browser.messages.list(folder.id)).messages.length
        );
        browser.test.assertTrue(
          (await browser.messages.getRaw(before.id)).includes(
            "Unrelated stored bytes"
          )
        );
        browser.test.notifyPass("physical-import");
      },
    });
    try {
      await extension.startup();
      await extension.awaitFinish("physical-import");
    } finally {
      await extension.unload();
      cleanUpAccount(account);
    }
  }
);
