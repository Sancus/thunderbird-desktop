/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests EWS save and detach attachments.
 *
 * This should closely match
 * mailnews/imap/test/unit/test_imapAttachmentSaves.js
 */

var { EwsServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/EwsServer.sys.mjs"
);
var { RemoteFolder } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockServer.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { mailTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
);
var { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MimeMessage.sys.mjs"
);
var { AttachmentInfo } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentInfo.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var incomingServer;
/** @type {EwsServer} */
var ewsServer;

const kAttachFileName = "bob.txt";

class SaveAttachmentCallbackListener {
  constructor() {
    this.attachments = null;
    this.deferred = Promise.withResolvers();
  }

  callback(aMsgHdr, aMimeMessage) {
    this.attachments = aMimeMessage.allAttachments;
    this.deferred.resolve();
  }
}

const gCallbackObject = new SaveAttachmentCallbackListener();

add_setup(async function () {
  [ewsServer, incomingServer] = setupBasicEwsTestServer({});

  registerCleanupFunction(() => {
    ewsServer.clearItems();
  });
});

add_task(async function testEwsAttachmentDetach() {
  const messageGenerator = new MessageGenerator();
  // create a synthetic message with attachment
  const smsg = messageGenerator.makeMessage({
    attachments: [{ filename: kAttachFileName, body: "I like cheese!" }],
  });

  const otherMessage = messageGenerator.makeMessage({ subject: "Unrelated" });
  const otherFolderId = "attachment-other-folder";
  ewsServer.appendRemoteFolder(new RemoteFolder(otherFolderId, "root"));
  ewsServer.addItemToFolder(
    "other_attachment_message",
    otherFolderId,
    otherMessage
  );

  const rootFolder = incomingServer.rootFolder;
  await syncFolder(incomingServer, rootFolder);
  const otherFolder = rootFolder.getChildNamed(otherFolderId);
  await syncFolder(incomingServer, otherFolder);
  const otherKey = mailTestUtils.firstMsgHdr(otherFolder).messageKey;

  const inboxFolder = rootFolder.getChildNamed("Inbox");
  Assert.ok(!!inboxFolder, "Inbox folder should exist.");
  await syncFolder(incomingServer, inboxFolder);

  // load and update a message in the fake EWS server
  ewsServer.addItemToFolder("attach_test_msg", "inbox", smsg);
  await syncFolder(incomingServer, inboxFolder);

  Assert.equal(
    1,
    inboxFolder.getTotalMessages(false),
    "Inbox should have the one message we added"
  );
  const msgHdr = mailTestUtils.firstMsgHdr(inboxFolder);
  Assert.ok(msgHdr instanceof Ci.nsIMsgDBHdr);
  const originalKey = msgHdr.messageKey;

  // process the message through mime
  MsgHdrToMimeMessage(
    msgHdr,
    gCallbackObject,
    gCallbackObject.callback,
    true // allowDownload
  );
  await gCallbackObject.deferred.promise;

  // detach any found attachments
  const attachment = new AttachmentInfo(gCallbackObject.attachments[0]);
  const profileDir = do_get_profile();
  await AttachmentInfo.detachAttachments(msgHdr, [attachment], profileDir.path);

  // Now test that the detachment was successful.
  const checkFile = do_get_profile().clone();
  checkFile.append(kAttachFileName);
  Assert.ok(
    checkFile.exists(),
    "Detached file should exist in the profile directory"
  );
  Assert.equal(await IOUtils.readUTF8(checkFile.path), "I like cheese!");

  // The message should now have a detached attachment. Read the message,
  // and search for "AttachmentDetached" which is added on detachment.

  // Resolve the replacement independently of other folders' message keys.
  Assert.equal(
    inboxFolder.getTotalMessages(false),
    1,
    "Inbox should still have exactly one message after detach"
  );
  const msgHdr2 = mailTestUtils.firstMsgHdr(inboxFolder);
  Assert.ok(!!msgHdr2, "Should have a message header");
  Assert.equal(msgHdr2.folder.URI, inboxFolder.URI);
  Assert.equal(msgHdr2.messageId, smsg.messageId);
  Assert.ok(!inboxFolder.msgDatabase.containsKey(originalKey));
  const remote = ewsServer.getItemInfo(msgHdr2.getStringProperty("ewsId"));
  Assert.ok(remote, "The replacement header has its actual remote identity");
  Assert.equal(remote.parentId, inboxFolder.getStringProperty("ewsId"));
  Assert.ok(!ewsServer.getItemInfo("attach_test_msg"));
  Assert.ok(inboxFolder.hasMsgOffline(msgHdr2.messageKey));
  Assert.equal(
    otherFolder.GetMessageHeader(otherKey).messageId,
    otherMessage.messageId
  );

  const messageContent = await getContentFromMessage(msgHdr2);
  Assert.stringContains(
    messageContent,
    "AttachmentDetached",
    "Message content should indicate that an attachment was detached"
  );
});

/**
 * Get the full message content.
 *
 * @param {nsIMsgDBHdr} aMsgHdr - Header object whose text body will be read.
 * @returns {Promise<string>} full message contents.
 */
function getContentFromMessage(aMsgHdr) {
  const msgFolder = aMsgHdr.folder;
  const msgUri = msgFolder.getUriForMsg(aMsgHdr);

  return new Promise((resolve, reject) => {
    const streamListener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      sis: Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
        Ci.nsIScriptableInputStream
      ),
      content: "",
      onDataAvailable(request, inputStream, offset, count) {
        this.sis.init(inputStream);
        this.content += this.sis.read(count);
      },
      onStartRequest() {},
      onStopRequest(request, statusCode) {
        this.sis.close();
        if (Components.isSuccessCode(statusCode)) {
          resolve(this.content);
        } else {
          reject(new Error(statusCode));
        }
      },
    };

    // Pass true for aLocalOnly since message should be in offline store.
    MailServices.messageServiceFromURI(msgUri).streamMessage(
      msgUri,
      streamListener,
      null,
      null,
      false, // aConvertData
      "",
      true // aLocalOnly
    );
  });
}
