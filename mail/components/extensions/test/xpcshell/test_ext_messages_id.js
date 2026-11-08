/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { AttachmentInfo } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentInfo.sys.mjs"
);

let gSubFolders;

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function setup() {
    // Returning a copy beside its original requires an actual COPYUID mapping.
    const account = await createAccount(undefined, { extensions: ["RFC4315"] });
    const rootFolder = account.incomingServer.rootFolder;
    gSubFolders = {
      test1: await createSubfolder(rootFolder, "test1"),
      test2: await createSubfolder(rootFolder, "test2"),
      test3: await createSubfolder(rootFolder, "test3"),
      attachment: await createSubfolder(rootFolder, "attachment"),
    };
    await createMessages(gSubFolders.test1, 5);
    const textAttachment = {
      body: "textAttachment",
      filename: "test.txt",
      contentType: "text/plain",
    };
    await createMessages(gSubFolders.attachment, {
      count: 1,
      subject: "Msg with text attachment",
      attachments: [textAttachment],
    });
  }
);

// In this test we'll move and copy some messages around between
// folders. Every operation should result in the message's id property
// changing to a never-seen-before value.
add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_identifiers() {
    const extension = ExtensionTestUtils.loadExtension({
      files: {
        "background.js": async () => {
          const [{ folders }] = await browser.accounts.list();
          const testFolder1 = folders.find(f => f.name == "test1");
          const testFolder2 = folders.find(f => f.name == "test2");
          const testFolder3 = folders.find(f => f.name == "test3");

          class OneTimeListener {
            constructor(type) {
              this.task = Promise.withResolvers();
              this.listener = (...args) => {
                browser.messages[type].removeListener(this.listener);
                this.task.resolve([...args]);
              };
              browser.messages[type].addListener(this.listener);
            }
            seen() {
              return this.task.promise;
            }
          }

          let { messages } = await browser.messages.list(testFolder1.id);
          browser.test.assertEq(
            5,
            messages.length,
            "message count in testFolder1"
          );
          browser.test.assertEq(1, messages[0].id);
          browser.test.assertEq(2, messages[1].id);
          browser.test.assertEq(3, messages[2].id);
          browser.test.assertEq(4, messages[3].id);
          browser.test.assertEq(5, messages[4].id);

          const subjects = messages.map(m => m.subject);

          // Move two messages. We could do this in one operation, but to be
          // sure of the order, do it in separate operations.
          const onMovedPart1 = new OneTimeListener("onMoved");
          await browser.messages.move([1], testFolder2.id);
          await onMovedPart1.seen();
          const onMovedPart2 = new OneTimeListener("onMoved");
          await browser.messages.move([3], testFolder2.id);
          await onMovedPart2.seen();

          ({ messages } = await browser.messages.list(testFolder1.id));
          browser.test.assertEq(
            3,
            messages.length,
            "message count in testFolder1"
          );
          browser.test.assertEq(2, messages[0].id);
          browser.test.assertEq(4, messages[1].id);
          browser.test.assertEq(5, messages[2].id);
          browser.test.assertEq(subjects[1], messages[0].subject);
          browser.test.assertEq(subjects[3], messages[1].subject);
          browser.test.assertEq(subjects[4], messages[2].subject);

          // It should not be possible to update the moved message.
          await browser.test.assertRejects(
            browser.messages.update(3, { flagged: true }),
            /Message not found: 3/,
            "Should not be able to update a no longer existing message"
          );

          // It should not be possible to get the moved message.
          await browser.test.assertRejects(
            browser.messages.get(1),
            /Message not found: 1/,
            "Should not be able to get a no longer existing message"
          );

          // It should not be possible to get the moved message.
          await browser.test.assertRejects(
            browser.messages.get(3),
            /Message not found: 3/,
            "Should not be able to get a no longer existing message"
          );

          ({ messages } = await browser.messages.list(testFolder2.id));
          browser.test.assertEq(
            2,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id, "new id created");
          browser.test.assertEq(7, messages[1].id, "new id created");
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);

          // Copy one message.

          const onCopied = new OneTimeListener("onCopied");
          await browser.messages.copy([6], testFolder3.id);
          await onCopied.seen();

          ({ messages } = await browser.messages.list(testFolder2.id));
          browser.test.assertEq(
            2,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id);
          browser.test.assertEq(7, messages[1].id);
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);

          ({ messages } = await browser.messages.list(testFolder3.id));
          browser.test.assertEq(
            1,
            messages.length,
            "message count in testFolder3"
          );
          browser.test.assertEq(8, messages[0].id, "new id created");
          browser.test.assertEq(subjects[0], messages[0].subject);

          // Move the copied message back to the previous folder. There should
          // now be two copies there, each with their own ID.

          const onMoved = new OneTimeListener("onMoved");
          await browser.messages.move([8], testFolder2.id);
          await onMoved.seen();

          ({ messages } = await browser.messages.list(testFolder2.id));
          browser.test.assertEq(
            3,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id);
          browser.test.assertEq(7, messages[1].id);
          browser.test.assertEq(
            9,
            messages[2].id,
            "new id created, not a duplicate"
          );
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);
          browser.test.assertEq(
            subjects[0],
            messages[2].subject,
            "same message as another in this folder"
          );

          // It should not be possible to update the moved message.
          await browser.test.assertRejects(
            browser.messages.update(8, { flagged: true }),
            /Message not found: 8/,
            "Should not be able to update a no longer existing message"
          );

          // It should not be possible to get the moved message.
          await browser.test.assertRejects(
            browser.messages.get(8),
            /Message not found: 8/,
            "Should not be able to get a no longer existing message"
          );

          browser.test.notifyPass("finished");
        },
        "utils.js": await getUtilsJS(),
      },
      manifest: {
        background: { scripts: ["utils.js", "background.js"] },
        permissions: [
          "accountsRead",
          "messagesMove",
          "messagesRead",
          "messagesUpdate",
        ],
      },
    });

    await extension.startup();
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

// In this test we'll remove an attachment from a message and its id property
// should not change. (Bug 1645595). Test does not work with IMAP test server,
// which has issues with attachments.
add_task(
  {
    skip_if: () => IS_NNTP || IS_IMAP,
  },
  async function test_attachments() {
    const extension = ExtensionTestUtils.loadExtension({
      files: {
        "background.js": async () => {
          browser.test.onMessage.addListener(async () => {
            // This listener gets called once the attachment has been removed.
            // Make sure we still get the message and it no longer has the
            // attachment.
            const modifiedMessage = await browser.messages.getFull(id);
            browser.test.assertEq(
              "Msg with text attachment",
              modifiedMessage.headers.subject[0]
            );
            browser.test.assertEq(
              "text/x-moz-deleted",
              modifiedMessage.parts[0].parts[1].contentType
            );
            browser.test.assertEq(
              "Deleted: test.txt",
              modifiedMessage.parts[0].parts[1].name
            );
            browser.test.notifyPass("finished");
          });

          const [{ folders }] = await browser.accounts.list();
          const testFolder = folders.find(f => f.name == "attachment");
          const { messages } = await browser.messages.list(testFolder.id);
          browser.test.assertEq(1, messages.length);
          const id = messages[0].id;

          const originalMessage = await browser.messages.getFull(id);
          browser.test.assertEq(
            "Msg with text attachment",
            originalMessage.headers.subject[0]
          );
          browser.test.assertEq(
            "text/plain",
            originalMessage.parts[0].parts[1].contentType
          );
          browser.test.assertEq(
            "test.txt",
            originalMessage.parts[0].parts[1].name
          );
          browser.test.sendMessage("removeAttachment", id);
        },
        "utils.js": await getUtilsJS(),
      },
      manifest: {
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesRead"],
      },
    });

    extension.onMessage("removeAttachment", async () => {
      const msgHdr = gSubFolders.attachment.messages.getNext();
      const msgUri = msgHdr.folder.getUriForMsg(msgHdr);
      const neckoURL = MailServices.neckoURLForMessageURI(msgUri);
      const attachment = new AttachmentInfo({
        contentType: "text/plain",
        url: `${neckoURL}&part=1.2&filename=test.txt`,
        name: "test.txt",
        uri: msgUri,
        message: msgHdr,
      });
      await AttachmentInfo.deleteAttachments(msgHdr, [attachment], true);
      extension.sendMessage();
    });

    await extension.startup();
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

add_task(
  { skip_if: () => IS_NNTP },
  async function test_rejectsReusedPhysicalSource() {
    const { MessageTracker } = ChromeUtils.importESModule(
      "resource:///modules/ExtensionMessages.sys.mjs"
    );
    const account = await createAccount();
    const folder = await createSubfolder(
      account.incomingServer.rootFolder,
      "physicalIdentity"
    );
    await createMessages(folder, 2);
    const headers = [...folder.messages];
    Assert.equal(
      headers.length,
      2,
      "The actual folder publishes two physical headers"
    );
    const native = Services.prefs.getBoolPref("mail.panorama.enabled");
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    Assert.equal(
      service instanceof Ci.nsIDatabaseCore,
      native,
      "The actual database service matches the selected backend"
    );
    const tracker = new MessageTracker(null);
    try {
      const first = tracker.getId(headers[0]);
      const second = tracker.getId(headers[1]);
      Assert.notEqual(
        first,
        second,
        "Different physical headers have distinct IDs"
      );
      Assert.equal(tracker.getMessage(first).messageId, headers[0].messageId);
      const retained = tracker.getIdentifier(headers[0]);
      if (IS_IMAP) {
        const info = folder.msgDatabase.dBFolderInfo;
        const epoch = info.imapUidValidity;
        Assert.greater(epoch, 0, "The real IMAP folder has an accepted epoch");
        try {
          info.imapUidValidity = epoch + 1;
          Assert.equal(
            tracker.getMessage(first),
            null,
            "An old ID cannot resolve a reused key in another epoch"
          );
          const replacement = tracker.getId(headers[0]);
          Assert.notEqual(replacement, first);
          tracker._remove(retained);
          Assert.equal(
            tracker.getMessage(replacement).messageId,
            headers[0].messageId,
            "A late old removal preserves the new mapping"
          );
        } finally {
          info.imapUidValidity = epoch;
        }
      } else {
        const root = account.incomingServer.rootFolder;
        root.propagateDelete(folder, true);
        const replacementFolder = await createSubfolder(
          root,
          "physicalIdentity"
        );
        await createMessages(replacementFolder, 2);
        Assert.equal(
          tracker.getMessage(first),
          null,
          "An old ID cannot resolve through a replacement database facade"
        );
        const current = [...replacementFolder.messages][0];
        const replacement = tracker.getId(current);
        Assert.notEqual(replacement, first);
        tracker._remove(retained);
        Assert.equal(
          tracker.getMessage(replacement).messageId,
          current.messageId
        );
      }
    } finally {
      tracker.cleanup();
      cleanUpAccount(account);
    }
  }
);

add_task(
  {
    skip_if: () =>
      IS_IMAP || IS_NNTP || Services.prefs.getBoolPref("mail.panorama.enabled"),
  },
  async function test_identifiersSurviveCompaction() {
    const account = await createAccount();
    const folder = await createSubfolder(
      account.incomingServer.rootFolder,
      "compactIdentity"
    );
    await createMessages(folder, 3);
    const extension = ExtensionTestUtils.loadExtension({
      manifest: {
        permissions: ["accountsRead", "messagesRead", "messagesDelete"],
      },
      async background() {
        const accounts = await browser.accounts.list();
        const selected = accounts
          .flatMap(item => item.folders)
          .find(item => item.name == "compactIdentity");
        const original = (await browser.messages.list(selected.id)).messages;
        browser.test.assertEq(3, original.length);
        await browser.messages.delete([original[0].id], {
          deletePermanently: true,
        });
        const before = (await browser.messages.list(selected.id)).messages;
        browser.test.assertEq(2, before.length);
        const compacted = new Promise(resolve => {
          const listener = () => {
            browser.test.onMessage.removeListener(listener);
            resolve();
          };
          browser.test.onMessage.addListener(listener);
        });
        browser.test.sendMessage("compact");
        await compacted;
        const lookedUp = await Promise.allSettled(
          before.map(message => browser.messages.get(message.id))
        );
        browser.test.assertDeepEq(
          ["fulfilled", "fulfilled"],
          lookedUp.map(result => result.status),
          "Compaction keeps both existing public IDs resolvable"
        );
        browser.test.assertDeepEq(
          before.map(message => message.id),
          lookedUp.map(result => result.value?.id),
          "Compaction preserves each existing public ID"
        );
        browser.test.assertDeepEq(
          before.map(message => message.headerMessageId),
          lookedUp.map(result => result.value?.headerMessageId),
          "Compaction resolves the same physical messages"
        );
        browser.test.assertDeepEq(
          before.map(message => message.id),
          (await browser.messages.list(selected.id)).messages.map(
            message => message.id
          ),
          "Compaction preserves the existing public message IDs"
        );
        browser.test.notifyPass("compaction");
      },
    });
    try {
      await extension.startup();
      await extension.awaitMessage("compact");
      const previousDatabase = folder.msgDatabase;
      const listener = new MailPromiseTestUtils.PromiseUrlListener();
      folder.compact(listener, null);
      await listener.promise;
      Assert.notEqual(
        folder.msgDatabase,
        previousDatabase,
        "Ordinary compaction replaces the database facade"
      );
      extension.sendMessage("compacted");
      await extension.awaitFinish("compaction");
    } finally {
      await extension.unload();
      cleanUpAccount(account);
    }
  }
);
