/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from test_ext_messages_query.js */

load("test_ext_messages_query.js");

add_task(async function test_queryWithoutGlobalIndex() {
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled"));
  Assert.ok(
    !Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled")
  );
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore
  );
  const account = await createAccount();
  const firstFolder = await createSubfolder(
    account.incomingServer.rootFolder,
    "SubstringFirst"
  );
  const secondFolder = await createSubfolder(
    account.incomingServer.rootFolder,
    "SubstringSecond"
  );
  Assert.equal(firstFolder.msgStore.storeType, "mbox");
  const generator = new MessageGenerator();
  const message = generator.makeMessage({
    subject: "prefixQuasarSuffix",
    from: ["OrdinalSender", "ordinal@example.invalid"],
    body: { body: "before bodyNeedle after literal OR two" },
  });
  message.messageId = "extension101-duplicate@example.invalid";
  await addGeneratedMessages(firstFolder, [message]);
  await addGeneratedMessages(secondFolder, [message]);
  await createMessages(firstFolder, {
    count: 1,
    subject: "Unrelated control",
    body: { body: "two before unrelated" },
  });
  const a = [...firstFolder.messages][0];
  const b = [...secondFolder.messages][0];
  const control = [...firstFolder.messages][1];
  firstFolder.markMessagesRead([a], true);
  firstFolder.markMessagesFlagged([a], true);
  firstFolder.addKeywordsToMessages([a], "$label1");
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [data] = await window.waitForMessage();
        const [first] = await browser.folders.query({ name: "SubstringFirst" });
        const [second] = await browser.folders.query({
          name: "SubstringSecond",
        });
        async function check(query, expected) {
          let page = await browser.messages.query({
            folderId: [first.id, second.id],
            autoPaginationTimeout: 0,
            messagesPerPage: 1,
            ...query,
          });
          const actual = [];
          while (true) {
            browser.test.assertTrue(page.messages.length <= 1);
            actual.push(...page.messages);
            if (!page.id) {
              break;
            }
            page = await browser.messages.continueList(page.id);
          }
          window.assertDeepEqual(
            expected,
            actual.map(m => m.id),
            JSON.stringify(query),
            { strict: true }
          );
          for (const m of actual) {
            const again = await browser.messages.get(m.id);
            browser.test.assertEq(m.folder.id, again.folder.id);
            browser.test.assertEq(m.headerMessageId, again.headerMessageId);
            browser.test.assertEq(data.accountId, m.folder.accountId);
            browser.test.assertEq(
              m.id == data.b ? "/SubstringSecond" : "/SubstringFirst",
              m.folder.path,
              "Current physical fixture location"
            );
            browser.test.assertEq(
              m.id == data.control
                ? data.controlMessageId
                : "extension101-duplicate@example.invalid",
              m.headerMessageId,
              "Literal fixture identity"
            );
            browser.test.assertEq(m.id == data.a, m.read, "Fixture read state");
            browser.test.assertEq(
              m.id == data.a,
              m.flagged,
              "Fixture star state"
            );
            window.assertDeepEqual(
              m.id == data.a ? ["$label1"] : [],
              m.tags,
              "Fixture tags",
              { strict: true }
            );
          }
        }
        await check({ subject: "Quasar" }, [data.a, data.b]);
        await check({ fullText: "Quasar" }, [data.a, data.b]);
        await check({ author: "OrdinalSender" }, [data.a, data.b]);
        await check({ fullText: "OrdinalSender" }, [data.a, data.b]);
        await check({ body: "bodyNeedle" }, [data.a, data.b]);
        await check({ fullText: "bodyNeedle" }, [data.a, data.b]);
        await check({ body: "literal OR two" }, [data.a, data.b]);
        await check({ body: "bodyNeedle OR unrelated" }, []);
        await check(
          {
            unread: false,
            flagged: true,
            tags: { mode: "all", tags: { $label1: true } },
          },
          [data.a]
        );
        await check({ unread: true, flagged: false, subject: "Quasar" }, [
          data.b,
        ]);
        await check({ folderId: [second.id, first.id], fullText: "Quasar" }, [
          data.b,
          data.a,
        ]);
        await check(
          {
            folderId: second.id,
            accountId: first.accountId,
            body: "bodyNeedle",
          },
          [data.b]
        );
        await check({ subject: "Unrelated" }, [data.control]);
        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });
  await extension.startup();
  const manager = WebExtensionPolicy.getByID(extension.id).extension
    .messageManager;
  extension.sendMessage({
    a: manager.convert(a).id,
    b: manager.convert(b).id,
    control: manager.convert(control).id,
    accountId: account.key,
    controlMessageId: control.messageId,
  });
  await extension.awaitFinish("finished");
  await extension.unload();
  const denied = ExtensionTestUtils.loadExtension({
    background: () => {
      browser.test.assertEq(
        undefined,
        browser.messages,
        "No messages API without messagesRead"
      );
      browser.test.notifyPass("denied");
    },
    manifest: { permissions: ["accountsRead"] },
  });
  await denied.startup();
  await denied.awaitFinish("denied");
  await denied.unload();
});
