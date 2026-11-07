/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var folder;
var epsilon;

var {
  create_body_part,
  create_deleted_attachment,
  create_detached_attachment,
  create_enclosure_attachment,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/AttachmentHelpers.sys.mjs"
);
var { be_in_folder, create_folder, get_about_message, select_click_row } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
const { add_message_to_folder, create_message, msgGen } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
  );

var { SyntheticPartLeaf, SyntheticPartMultiMixed } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);

var textAttachment =
  "Can't make the frug contest, Helen; stomach's upset. I'll fix you, " +
  "Ubik! Ubik drops you back in the thick of things fast. Taken as " +
  "directed, Ubik speeds relief to head and stomach. Remember: Ubik is " +
  "only seconds away. Avoid prolonged use.";

var binaryAttachment = textAttachment;

var imageAttachment =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAABHNCSVQICAgIfAhkiAAAAAlwS" +
  "FlzAAAN1wAADdcBQiibeAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAA" +
  "A5SURBVCiRY/z//z8DKYCJJNXkaGBgYGD4D8NQ5zUgiTVAxeBqSLaBkVRPM0KtIhrQ3km0jwe" +
  "SNQAAlmAY+71EgFoAAAAASUVORK5CYII=";
var imageSize = 188;

var vcardAttachment =
  "YmVnaW46dmNhcmQNCmZuOkppbSBCb2INCm46Qm9iO0ppbQ0KZW1haWw7aW50ZXJuZXQ6Zm9v" +
  "QGJhci5jb20NCnZlcnNpb246Mi4xDQplbmQ6dmNhcmQNCg0K";
var vcardSize = 90;

// create some messages that have various types of attachments
var messages = [
  {
    name: "text_attachment",
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    attachmentSizes: [textAttachment.length],
    attachmentTotalSize: { size: textAttachment.length, exact: true },
  },
  {
    name: "binary_attachment",
    attachments: [
      {
        body: binaryAttachment,
        contentType: "application/x-ubik",
        filename: "ubik",
        format: "",
      },
    ],
    attachmentSizes: [binaryAttachment.length],
    attachmentTotalSize: { size: binaryAttachment.length, exact: true },
  },
  {
    name: "image_attachment",
    attachments: [
      {
        body: imageAttachment,
        contentType: "image/png",
        filename: "lines.png",
        encoding: "base64",
        format: "",
      },
    ],
    attachmentSizes: [imageSize],
    attachmentTotalSize: { size: imageSize, exact: true },
  },
  {
    name: "detached_attachment",
    bodyPart: null,
    // Sizes filled in on message creation.
    attachmentSizes: [null],
    attachmentTotalSize: { size: 0, exact: true },
  },
  {
    name: "detached_attachment_with_missing_file",
    bodyPart: null,
    attachmentSizes: [-1],
    attachmentTotalSize: { size: 0, exact: false },
  },
  {
    name: "deleted_attachment",
    bodyPart: null,
    attachmentSizes: [-1],
    attachmentTotalSize: { size: 0, exact: true },
  },
  {
    name: "multiple_attachments",
    attachments: [
      { body: textAttachment, filename: "ubik.txt", format: "" },
      {
        body: binaryAttachment,
        contentType: "application/x-ubik",
        filename: "ubik",
        format: "",
      },
    ],
    attachmentSizes: [textAttachment.length, binaryAttachment.length],
    attachmentTotalSize: {
      size: textAttachment.length + binaryAttachment.length,
      exact: true,
    },
  },
  // vCards should be included in the attachment list.
  {
    name: "multiple_attachments_one_vcard",
    attachments: [
      { body: textAttachment, filename: "ubik.txt", format: "" },
      {
        body: vcardAttachment,
        contentType: "text/vcard",
        filename: "ubik.vcf",
        encoding: "base64",
        format: "",
      },
    ],
    attachmentSizes: [textAttachment.length, vcardSize],
    attachmentTotalSize: {
      size: textAttachment.length + vcardSize,
      exact: true,
    },
  },
  {
    name: "multiple_attachments_one_detached",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    attachmentSizes: [null, textAttachment.length],
    attachmentTotalSize: { size: textAttachment.length, exact: true },
  },
  {
    name: "multiple_attachments_one_detached_with_missing_file",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    attachmentSizes: [-1, textAttachment.length],
    attachmentTotalSize: { size: textAttachment.length, exact: false },
  },
  {
    name: "multiple_attachments_one_deleted",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    attachmentSizes: [-1, textAttachment.length],
    attachmentTotalSize: { size: textAttachment.length, exact: true },
  },
  // this is an attached message that itself has an attachment
  {
    name: "attached_message_with_attachment",
    bodyPart: null,
    attachmentSizes: [-1, textAttachment.length],
    attachmentTotalSize: { size: 0, exact: true },
  },
  {
    name: "unc_attachment",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    attachmentSizes: [-1, textAttachment.length],
    attachmentTotalSize: { size: textAttachment.length, exact: false },
  },
];

add_setup(async function () {
  /* Today's gory details (thanks to Jonathan Protzenko): libmime somehow
   * counts the trailing newline for an attachment MIME part. Most of the time,
   * assuming attachment has N bytes (no matter what's inside, newlines or
   * not), libmime will return N + 1 bytes. On Linux and Mac, this always
   * holds. However, on Windows, if the attachment is not encoded (that is, is
   * inline text), libmime will return N + 2 bytes.
   */
  epsilon = "@mozilla.org/windows-registry-key;1" in Cc ? 4 : 2;

  // set up our detached/deleted attachments
  var detachedFile = new FileUtils.File(getTestFilePath(`data/attachment.txt`));
  var detached = create_body_part("Here is a file", [
    create_detached_attachment(detachedFile, "text/plain"),
  ]);

  var missingFile = new FileUtils.File(getTestFilePath(`data/nonexistent.txt`));
  var missing = create_body_part(
    "Here is a file (but you deleted the external file, you silly oaf!)",
    [create_detached_attachment(missingFile, "text/plain")]
  );

  var deleted = create_body_part("Here is a file that you deleted", [
    create_deleted_attachment("deleted.txt", "text/plain"),
  ]);

  var attachedMessage = msgGen.makeMessage({
    body: { body: textAttachment },
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
  });

  var uncEnclosure = create_body_part("UNC enclosure", [
    create_enclosure_attachment(
      "meow.mp3",
      "audio/mpeg",
      "file:///%5c%5cattacker.tld%5cmeow"
    ),
  ]);

  /* Much like the above comment, libmime counts bytes differently on Windows,
   * where it counts newlines (\r\n) as 2 bytes. Mac and Linux treats them as
   * 1 byte.
   */
  var attachedMessageLength;
  if (epsilon == 4) {
    // Windows
    attachedMessageLength = attachedMessage.toMessageString().length;
  } else {
    // Mac/Linux
    attachedMessageLength = attachedMessage
      .toMessageString()
      .replace(/\r\n/g, "\n").length;
  }

  folder = await create_folder("AttachmentSizeA");
  for (let i = 0; i < messages.length; i++) {
    // First, add any missing info to the message object.
    switch (messages[i].name) {
      case "detached_attachment":
      case "multiple_attachments_one_detached":
        messages[i].bodyPart = detached;
        messages[i].attachmentSizes[0] = detachedFile.fileSize;
        messages[i].attachmentTotalSize.size += detachedFile.fileSize;
        break;
      case "detached_attachment_with_missing_file":
      case "multiple_attachments_one_detached_with_missing_file":
        messages[i].bodyPart = missing;
        break;
      case "deleted_attachment":
      case "multiple_attachments_one_deleted":
        messages[i].bodyPart = deleted;
        break;
      case "attached_message_with_attachment":
        messages[i].bodyPart = new SyntheticPartMultiMixed([
          new SyntheticPartLeaf("I am text!", { contentType: "text/plain" }),
          attachedMessage,
        ]);
        messages[i].attachmentSizes[0] = attachedMessageLength;
        messages[i].attachmentTotalSize.size += attachedMessageLength;
        break;
      case "unc_attachment":
        messages[i].bodyPart = uncEnclosure;
        break;
    }

    await add_message_to_folder([folder], create_message(messages[i]));
  }
});

/**
 * Make sure that the attachment's size is what we expect
 *
 * @param {integer} index - The attachment's index, starting at 0.
 * @param {integer} expectedSize - The expected size of the attachment, in bytes.
 */
function check_attachment_size(index, expectedSize) {
  const win = get_about_message();
  const list = win.document.getElementById("attachmentList");
  const node = list.querySelectorAll("richlistitem.attachmentItem")[index];

  // First, let's check that the attachment size is correct
  const size = node.attachment.size;
  Assert.lessOrEqual(
    Math.abs(size - expectedSize),
    epsilon,
    `Attachment "${node.attachment.name}" size should be within ${epsilon} ` +
      `of ${expectedSize} (actual: ${size})`
  );

  // Next, make sure that the formatted size in the label is correct
  Assert.equal(
    node.getAttribute("size"),
    MailUtils.formatFileSize(size),
    `Attachment "${node.attachment.name}" displayed size should match`
  );
}

/**
 * Make sure that the attachment's size is not displayed
 *
 * @param {integer} index - The attachment's index, starting at 0.
 */
function check_no_attachment_size(index) {
  const win = get_about_message();
  const list = win.document.getElementById("attachmentList");
  const node = list.querySelectorAll("richlistitem.attachmentItem")[index];

  Assert.equal(
    node.attachment.size,
    -1,
    `Attachment "${node.attachment.name}" should have a size of -1`
  );

  // If there's no size, the size attribute is the zero-width space.
  const nodeSize = node.getAttribute("size");
  Assert.equal(
    nodeSize,
    "",
    `Attachment "${node.attachment.name}" size should not be displayed`
  );
}

/**
 * Make sure that the total size of all attachments is what we expect.
 *
 * @param {integer} count - The expected number of attachments.
 * @param {integer} expectedSize - The expected size in bytes of all the attachments.
 * @param {boolean} exact - true if the size of all attachments is known.
 */
function check_total_attachment_size(count, expectedSize, exact) {
  const win = get_about_message();
  const list = win.document.getElementById("attachmentList");
  const nodes = list.querySelectorAll("richlistitem.attachmentItem");
  const sizeNode = win.document.getElementById("attachmentSize");

  Assert.equal(
    nodes.length,
    count,
    "Should have the expected number of attachments"
  );

  let lastPartID;
  let size = 0;
  for (let i = 0; i < nodes.length; i++) {
    const attachment = nodes[i].attachment;
    if (!lastPartID || attachment.partID.indexOf(lastPartID) != 0) {
      lastPartID = attachment.partID;
      const currSize = attachment.size;
      if (currSize > 0 && !isNaN(currSize)) {
        size += Number(currSize);
      }
    }
  }

  Assert.lessOrEqual(
    Math.abs(size - expectedSize),
    epsilon * count,
    `Total attachments size should be within ${epsilon * count} ` +
      `of ${expectedSize} (actual: ${size})`
  );

  // Next, make sure that the formatted size in the label is correct
  const formattedSize = sizeNode.getAttribute("value");
  let expectedFormattedSize = MailUtils.formatFileSize(size);
  const messengerBundle = document.getElementById("bundle_messenger");

  if (!exact) {
    if (size == 0) {
      expectedFormattedSize = messengerBundle.getString(
        "attachmentSizeUnknown"
      );
    } else {
      expectedFormattedSize = messengerBundle.getFormattedString(
        "attachmentSizeAtLeast",
        [expectedFormattedSize]
      );
    }
  }
  Assert.equal(
    formattedSize,
    expectedFormattedSize,
    "Displayed attachments total size should match"
  );
}

/**
 * Make sure that the individual and total attachment sizes for this message
 * are as expected
 *
 * @param {integer} index - The index of the message to check in the thread pane.
 */
async function help_test_attachment_size(index) {
  await be_in_folder(folder);
  await select_click_row(index);
  info(`Testing message ${index}: ${messages[index].name}`);
  const expectedSizes = messages[index].attachmentSizes;

  const aboutMessage = get_about_message();
  aboutMessage.toggleAttachmentList(true);

  const attachmentList = aboutMessage.document.getElementById("attachmentList");
  await TestUtils.waitForCondition(
    () => !attachmentList.collapsed,
    "Attachment list is shown"
  );

  for (let i = 0; i < expectedSizes.length; i++) {
    if (expectedSizes[i] == -1) {
      check_no_attachment_size(i);
    } else {
      check_attachment_size(i, expectedSizes[i]);
    }
  }

  const totalSize = messages[index].attachmentTotalSize;
  check_total_attachment_size(
    expectedSizes.length,
    totalSize.size,
    totalSize.exact
  );
}

add_task(async function test_attachment_sizes() {
  for (let i = 0; i < messages.length; i++) {
    await help_test_attachment_size(i);
  }
});

registerCleanupFunction(() => {
  // Remove created folders.
  folder.deleteSelf(null);
});

add_task(function test_attachmentPartIdentityAcrossMessageUrls() {
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  for (const [url, expectedPart, external, expectedUrl = url] of [
    ["mailbox:///mail/Inbox?number=7&part=1.2&filename=note.txt", "1.2", false],
    [
      "imap://user@localhost/fetch%3EUID%3EInbox%3E7?part=1.2.3",
      "1.2.3",
      false,
    ],
    [
      "news://example.invalid/article?/;section=2?part=1.2&filename=note.txt",
      "1.2",
      false,
    ],
    ["mailbox:///mail/Inbox?number=7&filename=note.txt", null, false],
    [
      "file:///mail/attached.txt?part=1.4",
      "1.4",
      true,
      "file:///mail/attached.txt",
    ],
    [
      "https://example.invalid/attached.txt?download=1&part=1.5",
      "1.5",
      true,
      "https://example.invalid/attached.txt?download=1",
    ],
  ]) {
    const attachment = new AttachmentInfo({
      contentType: "text/plain",
      name: "note.txt",
      uri: "mailbox-message://nobody@Local%20Folders/Inbox#7",
      url,
      isExternalAttachment: external,
    });
    Assert.equal(attachment.partID, expectedPart, `Part identity for ${url}`);
    Assert.equal(attachment.url, expectedUrl, `Reader URL for ${url}`);
  }
});


add_task(async function test_selectedPhysicalMimePartsRetainNamesAndSizes() {
  const copies = [];
  try {
    for (let index = 0; index < 2; index++) {
      const selectedFolder = await create_folder(`S376MimeParts${index}`);
      copies.push(selectedFolder);
      const body = `The physical attachment in folder ${index}.`;
      const name = `selected-${index}-\u{1F98A}.txt`;
      const message = create_message({
        attachments: [{ body, filename: name, format: "" }],
      });
      message.messageId = "s376-repeated-mime@example.invalid";
      await add_message_to_folder([selectedFolder], message);
      const [header] = [...selectedFolder.messages];
      Assert.equal(selectedFolder.getTotalMessages(false), 1);
      const expectedKey = header.messageKey;
      if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
        const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
          Ci.nsIDatabaseCore
        );
        Assert.ok(core.sourceId, "The actual native database is active");
      }
      const expectedStore = Services.prefs
        .getStringPref("mail.serverDefaultStoreContractID")
        .includes("maildirstore") ? "maildir" : "mbox";
      Assert.equal(selectedFolder.msgStore.storeType, expectedStore);
      await be_in_folder(selectedFolder);
      await select_click_row(0);
      const reader = get_about_message();
      await TestUtils.waitForCondition(
        () => reader.currentAttachments.length == 1,
        "the selected stored message supplies its MIME part"
      );
      const [attachment] = reader.currentAttachments;
      await TestUtils.waitForCondition(() => attachment.sizeResolved);
      Assert.equal(reader.gMessage.folder.URI, selectedFolder.URI);
      Assert.equal(reader.gMessage.messageKey, expectedKey);
      Assert.equal(attachment.message.folder.URI, selectedFolder.URI);
      Assert.equal(attachment.message.messageKey, expectedKey);
      Assert.equal(attachment.name, name);
      Assert.equal(attachment.size, body.length);
      Assert.equal(attachment.partID, "1.2");
      Assert.equal(
        new TextDecoder().decode(await attachment.fetchAttachment()),
        body,
        "part bytes belong to this physical copy despite repeated Message-ID"
      );
    }
    const [first] = [...copies[0].messages];
    const [second] = [...copies[1].messages];
    Assert.equal(first.messageId, second.messageId);
    Assert.notEqual(first.folder.URI, second.folder.URI);
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      Assert.notEqual(first.messageKey, second.messageKey);
    }
  } finally {
    await be_in_folder(folder);
    for (const selectedFolder of copies) {
      selectedFolder.deleteSelf(null);
    }
  }
});
