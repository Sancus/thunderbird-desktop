/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var folder;

var {
  create_body_part,
  create_deleted_attachment,
  create_detached_attachment,
  create_enclosure_attachment,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/AttachmentHelpers.sys.mjs"
);
var {
  be_in_folder,
  close_popup,
  create_folder,
  get_about_message,
  open_message_from_file,
  select_click_row,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
const { add_message_to_folder, create_message } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);
const { MockFilePicker } = ChromeUtils.importESModule(
  "resource://testing-common/MockFilePicker.sys.mjs"
);

var aboutMessage = get_about_message();

var textAttachment =
  "Can't make the frug contest, Helen; stomach's upset. I'll fix you, " +
  "Ubik! Ubik drops you back in the thick of things fast. Taken as " +
  "directed, Ubik speeds relief to head and stomach. Remember: Ubik is " +
  "only seconds away. Avoid prolonged use.";

// create some messages that have various types of attachments
var messages = [
  {
    name: "regular_attachment",
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [{ open: true, save: true, detach: true, delete_: true }],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "detached_attachment",
    bodyPart: null,
    menuStates: [{ open: true, save: true, detach: false, delete_: false }],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "detached_attachment_with_missing_file",
    bodyPart: null,
    menuStates: [{ open: false, save: false, detach: false, delete_: false }],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "deleted_attachment",
    bodyPart: null,
    menuStates: [{ open: false, save: false, detach: false, delete_: false }],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "multiple_attachments",
    attachments: [
      { body: textAttachment, filename: "ubik.txt", format: "" },
      { body: textAttachment, filename: "ubik2.txt", format: "" },
    ],
    menuStates: [
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_one_detached",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_one_detached_with_missing_file",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_one_deleted",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_all_detached",
    bodyPart: null,
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: true, save: true, detach: false, delete_: false },
    ],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "multiple_attachments_all_detached_with_missing_files",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "multiple_attachments_all_deleted",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "link_enclosure_valid",
    bodyPart: null,
    menuStates: [{ open: true, save: true, detach: false, delete_: false }],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "link_enclosure_invalid",
    bodyPart: null,
    menuStates: [{ open: false, save: false, detach: false, delete_: false }],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures",
    bodyPart: null,
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: true, save: true, detach: false, delete_: false },
    ],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures_one_invalid",
    bodyPart: null,
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures_all_invalid",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures_all_links_invalid",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "attachments_with_unsafe_names",
    attachments: [
      { body: textAttachment, filename: "../ubik.txt", format: "" },
      { body: textAttachment, filename: "sub/ubik2.txt", format: "" },
      { body: textAttachment, filename: "..", format: "" },
    ],
    menuStates: [
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "attachments_with_colliding_names",
    attachments: [
      { body: "first", filename: "ubik.txt", format: "" },
      { body: "second", filename: "ubik.txt", format: "" },
      { body: "third", filename: "UBIK.txt", format: "" },
      { body: "fourth", filename: "ubik(1).txt", format: "" },
    ],
    menuStates: [
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
];

add_setup(async function () {
  // set up our detached/deleted attachments
  var detachedFile = new FileUtils.File(getTestFilePath(`data/attachment.txt`));
  var detached = create_body_part("Here is a file", [
    create_detached_attachment(detachedFile, "text/plain"),
  ]);
  var multiple_detached = create_body_part("Here are some files", [
    create_detached_attachment(detachedFile, "text/plain"),
    create_detached_attachment(detachedFile, "text/plain"),
  ]);

  var missingFile = new FileUtils.File(getTestFilePath(`data/nonexistent.txt`));
  var missing = create_body_part(
    "Here is a file (but you deleted the external file, you silly oaf!)",
    [create_detached_attachment(missingFile, "text/plain")]
  );
  var multiple_missing = create_body_part(
    "Here are some files (but you deleted the external files, you silly oaf!)",
    [
      create_detached_attachment(missingFile, "text/plain"),
      create_detached_attachment(missingFile, "text/plain"),
    ]
  );

  var deleted = create_body_part("Here is a file that you deleted", [
    create_deleted_attachment("deleted.txt", "text/plain"),
  ]);
  var multiple_deleted = create_body_part(
    "Here are some files that you deleted",
    [
      create_deleted_attachment("deleted.txt", "text/plain"),
      create_deleted_attachment("deleted.txt", "text/plain"),
    ]
  );

  var enclosure_valid_url = create_body_part("My blog has the best enclosure", [
    create_enclosure_attachment(
      "purr.mp3",
      "audio/mpeg",
      "https://example.com",
      12345678
    ),
  ]);
  var enclosure_invalid_url = create_body_part(
    "My blog has the best enclosure with a dead link",
    [
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
    ]
  );
  var multiple_enclosures = create_body_part(
    "My blog has the best 2 cat sound enclosures",
    [
      create_enclosure_attachment(
        "purr.mp3",
        "audio/mpeg",
        "https://example.com",
        1234567
      ),
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com",
        987654321
      ),
    ]
  );
  var multiple_enclosures_one_link_invalid = create_body_part(
    "My blog has the best 2 cat sound enclosures but one is invalid",
    [
      create_enclosure_attachment(
        "purr.mp3",
        "audio/mpeg",
        "https://example.com",
        1234567
      ),
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
    ]
  );
  var multiple_enclosures_all_links_invalid = create_body_part(
    "My blog has 2 enclosures with 2 bad links",
    [
      create_enclosure_attachment(
        "purr.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
    ]
  );
  var link_multiple_enclosures_all_links_invalid = create_body_part(
    "Bad file links",
    [
      create_enclosure_attachment(
        "meow1.mp3",
        "audio/mpeg",
        "file:///\\1.2.3.4/asd"
      ),
      create_enclosure_attachment(
        "meow2.mp3",
        "audio/mpeg",
        "file://///1.2.3.4/asd"
      ),
      create_enclosure_attachment(
        "meow3.mp3",
        "audio/mpeg",
        "file:///%5c%5c1.2.3.4/asd"
      ),
      create_enclosure_attachment(
        "meow4.mp3",
        "audio/mpeg",
        "file:///%5c%5cattacker.tld%5cmeow"
      ),
      create_enclosure_attachment(
        "meow5.mp3",
        "audio/mpeg",
        "chrome://messenger/content/messenger.xhtml"
      ),
      create_enclosure_attachment(
        "meow6.mp3",
        "audio/mpeg",
        "smtp://example.com?foobar"
      ),
    ]
  );

  folder = await create_folder("AttachmentMenusA");
  for (let i = 0; i < messages.length; i++) {
    // First, add any missing info to the message object.
    switch (messages[i].name) {
      case "detached_attachment":
      case "multiple_attachments_one_detached":
        messages[i].bodyPart = detached;
        break;
      case "multiple_attachments_all_detached":
        messages[i].bodyPart = multiple_detached;
        break;
      case "detached_attachment_with_missing_file":
      case "multiple_attachments_one_detached_with_missing_file":
        messages[i].bodyPart = missing;
        break;
      case "multiple_attachments_all_detached_with_missing_files":
        messages[i].bodyPart = multiple_missing;
        break;
      case "deleted_attachment":
      case "multiple_attachments_one_deleted":
        messages[i].bodyPart = deleted;
        break;
      case "multiple_attachments_all_deleted":
        messages[i].bodyPart = multiple_deleted;
        break;
      case "link_enclosure_valid":
        messages[i].bodyPart = enclosure_valid_url;
        messages[i].feedMessage = true;
        break;
      case "link_enclosure_invalid":
        messages[i].bodyPart = enclosure_invalid_url;
        messages[i].feedMessage = true;
        break;
      case "link_multiple_enclosures":
        messages[i].bodyPart = multiple_enclosures;
        messages[i].feedMessage = true;
        break;
      case "link_multiple_enclosures_one_invalid":
        messages[i].bodyPart = multiple_enclosures_one_link_invalid;
        messages[i].feedMessage = true;
        break;
      case "link_multiple_enclosures_all_invalid":
        messages[i].bodyPart = multiple_enclosures_all_links_invalid;
        break;
      case "link_multiple_enclosures_all_links_invalid":
        messages[i].bodyPart = link_multiple_enclosures_all_links_invalid;
        break;
    }

    await add_message_to_folder([folder], create_message(messages[i]));
    if (messages[i].feedMessage) {
      // Feeds allow special behaviors. Add flag if we're testing such a case.
      // In particular, http attachments (enclosures) are allowed.
      const msg = [...folder.messages].at(-1);
      msg.orFlags(Ci.nsMsgMessageFlags.FeedMsg);
    }
  }
});

/**
 * Ensure that the specified element is visible/hidden
 *
 * @param {string} id - The id of the element to check.
 * @param {boolean} visible - true if the element should be visible.
 */
function assert_shown(id, visible) {
  Assert.notEqual(
    aboutMessage.document.getElementById(id).hidden,
    visible,
    `"${id}" should be ${visible ? "visible" : "hidden"}`
  );
}

/**
 * Ensure that the specified element is enabled/disabled
 *
 * @param {string} id the id of the element to check
 * @param {boolean} enabled true if the element should be enabled.
 */
function assert_enabled(id, enabled) {
  Assert.notEqual(
    aboutMessage.document.getElementById(id).disabled,
    enabled,
    `"${id}" should be ${enabled ? "enabled" : "disabled"}`
  );
}

/**
 * Check that the menu states in the "save" toolbar button are correct.
 *
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_toolbar_menu_states_single(expected) {
  assert_shown("attachmentSaveAllSingle", true);
  assert_shown("attachmentSaveAllMultiple", false);

  if (expected.save === false) {
    assert_enabled("attachmentSaveAllSingle", false);
  } else {
    assert_enabled("attachmentSaveAllSingle", true);
    const dm = aboutMessage.document.querySelector(
      "#attachmentSaveAllSingle .toolbarbutton-menubutton-dropmarker"
    );
    EventUtils.synthesizeMouseAtCenter(dm, { clickCount: 1 }, aboutMessage);
    await BrowserTestUtils.waitForPopupEvent(
      aboutMessage.document.getElementById("attachmentSaveAllSingleMenu"),
      "shown"
    );

    try {
      assert_enabled("button-openAttachment", expected.open);
      assert_enabled("button-saveAttachment", expected.save);
      assert_enabled("button-detachAttachment", expected.detach);
      assert_enabled("button-deleteAttachment", expected.delete_);
    } finally {
      await close_popup(
        aboutMessage,
        aboutMessage.document.getElementById("attachmentSaveAllSingleMenu")
      );
    }
  }
}

/**
 * Check that the menu states in the "save all" toolbar button are correct.
 *
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_toolbar_menu_states_multiple(expected) {
  assert_shown("attachmentSaveAllSingle", false);
  assert_shown("attachmentSaveAllMultiple", true);

  if (expected.save === false) {
    assert_enabled("attachmentSaveAllMultiple", false);
  } else {
    assert_enabled("attachmentSaveAllMultiple", true);
    const dm = aboutMessage.document.querySelector(
      "#attachmentSaveAllMultiple .toolbarbutton-menubutton-dropmarker"
    );
    EventUtils.synthesizeMouseAtCenter(dm, { clickCount: 1 }, aboutMessage);
    await BrowserTestUtils.waitForPopupEvent(
      aboutMessage.document.getElementById("attachmentSaveAllMultipleMenu"),
      "shown"
    );

    try {
      assert_enabled("button-openAllAttachments", expected.open);
      assert_enabled("button-saveAllAttachments", expected.save);
      assert_enabled("button-detachAllAttachments", expected.detach);
      assert_enabled("button-deleteAllAttachments", expected.delete_);
    } finally {
      await close_popup(
        window,
        aboutMessage.document.getElementById("attachmentSaveAllMultipleMenu")
      );
    }
  }
}

/**
 * Check that the menu states in the single item context menu are correct
 *
 * @param {integer} index - Index of the attachment in the attachmentList.
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_menu_states_single(index, expected) {
  const attachmentList = aboutMessage.document.getElementById("attachmentList");
  const node = attachmentList.getItemAtIndex(index);
  Assert.ok(!!node, `Attachment at index ${index} should exist`);

  const contextMenu = aboutMessage.document.getElementById(
    "attachmentItemContext"
  );
  const shownPromise = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  attachmentList.selectItem(node);
  EventUtils.synthesizeMouseAtCenter(
    node,
    { type: "contextmenu" },
    aboutMessage
  );
  await shownPromise;

  try {
    assert_shown("context-openAttachment", true);
    assert_shown("context-saveAttachment", true);
    assert_shown("context-menu-separator", true);
    assert_shown("context-detachAttachment", true);
    assert_shown("context-deleteAttachment", true);

    assert_enabled("context-openAttachment", expected.open);
    assert_enabled("context-saveAttachment", expected.save);
    assert_enabled("context-detachAttachment", expected.detach);
    assert_enabled("context-deleteAttachment", expected.delete_);
  } finally {
    const hiddenPromise = BrowserTestUtils.waitForEvent(
      contextMenu,
      "popuphidden"
    );
    contextMenu.hidePopup();
    await hiddenPromise;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/**
 * Check that the menu states in the all items context menu are correct
 *
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_menu_states_all(expected) {
  // Using a rightClick here is unsafe, because we need to hit the empty area
  // beside the attachment items and that seems to be different per platform.
  // Using DOM methods to open the popup works fine.
  const contextMenu = aboutMessage.document.getElementById(
    "attachmentListContext"
  );
  const shownPromise = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  aboutMessage.document
    .getElementById("attachmentListContext")
    .openPopup(aboutMessage.document.getElementById("attachmentList"));
  await shownPromise;

  try {
    assert_shown("context-openAllAttachments", true);
    assert_shown("context-saveAllAttachments", true);
    assert_shown("context-menu-separator-all", true);
    assert_shown("context-detachAllAttachments", true);
    assert_shown("context-deleteAllAttachments", true);

    assert_enabled("context-openAllAttachments", expected.open);
    assert_enabled("context-saveAllAttachments", expected.save);
    assert_enabled("context-detachAllAttachments", expected.detach);
    assert_enabled("context-deleteAllAttachments", expected.delete_);
  } finally {
    await close_popup(
      aboutMessage,
      aboutMessage.document.getElementById("attachmentListContext")
    );
  }
}

async function help_test_attachment_menus(index) {
  await be_in_folder(folder);
  await select_click_row(index);
  const expectedStates = messages[index].menuStates;

  aboutMessage.toggleAttachmentList(true);

  for (const attachment of aboutMessage.currentAttachments) {
    // Ensure all attachments are resolved; other than external they already
    // should be.
    await attachment.isEmpty();
  }

  if (expectedStates.length == 1) {
    await check_toolbar_menu_states_single(messages[index].allMenuStates);
  } else {
    await check_toolbar_menu_states_multiple(messages[index].allMenuStates);
  }

  await check_menu_states_all(messages[index].allMenuStates);
  for (let i = 0; i < expectedStates.length; i++) {
    await check_menu_states_single(i, expectedStates[i]);
  }
}

// Generate a test for each message in |messages|.
for (let i = 0; i < messages.length; i++) {
  add_task(function () {
    return help_test_attachment_menus(i);
  });
}

/**
 * Select a message, expand the attachment list, and wait for the size of all
 * attachments to be resolved.
 *
 * @param {string} name - The name of the message in |messages|.
 */
async function select_message_with_attachments(name) {
  await be_in_folder(folder);
  aboutMessage = get_about_message();
  await select_click_row(messages.findIndex(m => m.name == name));
  aboutMessage.toggleAttachmentList(true);
  for (const attachment of aboutMessage.currentAttachments) {
    await attachment.isEmpty();
  }
}

/**
 * Activate "Copy Link Location" in the context menu of an attachment.
 *
 * @param {integer} index - Index of the attachment in the attachmentList.
 */
async function activate_copy_attachment_url(index) {
  const attachmentList = aboutMessage.document.getElementById("attachmentList");
  const contextMenu = aboutMessage.document.getElementById(
    "attachmentItemContext"
  );
  const shownPromise = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  const node = attachmentList.getItemAtIndex(index);
  attachmentList.selectItem(node);
  EventUtils.synthesizeMouseAtCenter(
    node,
    { type: "contextmenu" },
    aboutMessage
  );
  await shownPromise;

  assert_shown("context-copyAttachmentUrl", true);
  const hiddenPromise = BrowserTestUtils.waitForEvent(
    contextMenu,
    "popuphidden"
  );
  contextMenu.activateItem(
    aboutMessage.document.getElementById("context-copyAttachmentUrl")
  );
  await hiddenPromise;
}

/**
 * Tests that "Copy Link Location" copies the location the attachment points
 * to, and not the attachment's file name.
 */
add_task(async function test_copy_attachment_url_detached() {
  const detachedFile = new FileUtils.File(
    getTestFilePath("data/attachment.txt")
  );
  const expectedUrl = decodeURI(
    Services.io.newFileURI(detachedFile).displaySpec
  );

  await select_message_with_attachments("detached_attachment");
  await SimpleTest.promiseClipboardChange(expectedUrl, () =>
    activate_copy_attachment_url(0)
  );
});

add_task(async function test_copy_attachment_url_link() {
  await select_message_with_attachments("link_enclosure_valid");
  await SimpleTest.promiseClipboardChange("https://example.com/", () =>
    activate_copy_attachment_url(0)
  );
});

/**
 * Tests that the "all attachments" commands act on the attachments that are
 * still there, when one of the attachments has already been deleted.
 */
add_task(async function test_all_commands_with_deleted_attachment() {
  await be_in_folder(folder);
  aboutMessage = get_about_message();
  await select_click_row(
    messages.findIndex(m => m.name == "multiple_attachments_one_deleted")
  );
  aboutMessage.toggleAttachmentList(true);
  for (const attachment of aboutMessage.currentAttachments) {
    await attachment.isEmpty();
  }
  Assert.equal(
    aboutMessage.currentAttachments.length,
    2,
    "Message should have two attachments, one of them deleted"
  );

  const saveDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  saveDir.append("save-all-with-deleted");
  if (saveDir.exists()) {
    saveDir.remove(true);
  }
  saveDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  MockFilePicker.init();
  registerCleanupFunction(() => saveDir.remove(true));

  // "Save All" should save the attachment that is still there.
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  MockFilePicker.useDirectory(saveDir.path);
  const saved = BrowserTestUtils.waitForEvent(window, "attachmentsSaved");
  EventUtils.synthesizeMouseAtCenter(
    aboutMessage.document.getElementById("attachmentSaveAllMultiple"),
    {},
    aboutMessage
  );
  await saved;
  Assert.deepEqual(
    (await IOUtils.getChildren(saveDir.path)).map(p => PathUtils.filename(p)),
    ["ubik.txt"],
    "Only the attachment that is still there should have been saved"
  );

  // "Detach All" should ask where to save the remaining attachment. Cancelling
  // the file picker aborts the operation, leaving the message untouched.
  MockFilePicker.reset();
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  let pickerShown = false;
  MockFilePicker.showCallback = () => {
    pickerShown = true;
  };
  aboutMessage.goDoCommand("cmd_detachAllAttachments");
  await TestUtils.waitForCondition(
    () => pickerShown,
    "file picker should be shown for detach"
  );

  // "Delete All" should ask for confirmation for the remaining attachment.
  // Cancelling leaves the message untouched.
  const confirmed = BrowserTestUtils.promiseAlertDialogOpen("cancel");
  aboutMessage.goDoCommand("cmd_deleteAllAttachments");
  await confirmed;

  MockFilePicker.cleanup();
});

/**
 * Tests that "Save All" saves attachments with names that aren't valid file
 * names inside the chosen directory, under sanitized names.
 */
add_task(async function test_save_all_unsafe_names() {
  await select_message_with_attachments("attachments_with_unsafe_names");

  const parentDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  parentDir.append("save-all-unsafe");
  if (parentDir.exists()) {
    parentDir.remove(true);
  }
  const saveDir = parentDir.clone();
  saveDir.append("chosen");
  saveDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  registerCleanupFunction(() => parentDir.remove(true));

  MockFilePicker.init();
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  MockFilePicker.useDirectory(saveDir.path);
  const saved = BrowserTestUtils.waitForEvent(window, "attachmentsSaved");
  EventUtils.synthesizeMouseAtCenter(
    aboutMessage.document.getElementById("attachmentSaveAllMultiple"),
    {},
    aboutMessage
  );
  await saved;
  MockFilePicker.cleanup();

  Assert.deepEqual(
    (await IOUtils.getChildren(parentDir.path)).map(p => PathUtils.filename(p)),
    ["chosen"],
    "Nothing should have been saved outside the chosen directory"
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(saveDir.path))
      .map(p => PathUtils.filename(p))
      .sort(),
    ["_ubik.txt", "attachment", "sub_ubik2.txt"],
    "All attachments should have been saved under sanitized names"
  );
});

/**
 * Tests that "Save All" saves attachments with colliding names to separate,
 * numbered files.
 */
add_task(async function test_save_all_colliding_names() {
  await select_message_with_attachments("attachments_with_colliding_names");

  const saveDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  saveDir.append("save-all-colliding");
  if (saveDir.exists()) {
    saveDir.remove(true);
  }
  saveDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  registerCleanupFunction(() => saveDir.remove(true));

  MockFilePicker.init();
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  MockFilePicker.useDirectory(saveDir.path);
  const saved = BrowserTestUtils.waitForEvent(window, "attachmentsSaved");
  EventUtils.synthesizeMouseAtCenter(
    aboutMessage.document.getElementById("attachmentSaveAllMultiple"),
    {},
    aboutMessage
  );
  await saved;
  MockFilePicker.cleanup();

  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(saveDir.path, "ubik.txt")),
    "first",
    "The first attachment should keep its name"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(saveDir.path, "ubik(2).txt")),
    "second",
    "The second attachment should have been saved under a numbered name"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(saveDir.path, "UBIK(3).txt")),
    "third",
    "The third attachment should have been saved under a numbered name"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(saveDir.path, "ubik(1).txt")),
    "fourth",
    "An attachment whose name doesn't collide should keep its name"
  );
});

/**
 * Tests that "Detach All" leaves an existing file alone if the user declines
 * replacing it.
 */
add_task(async function test_detach_all_decline_replace() {
  const detachFolder = await create_folder("AttachmentMenusDetach");
  registerCleanupFunction(() => detachFolder.deleteSelf(null));
  await add_message_to_folder(
    [detachFolder],
    create_message({
      attachments: [
        { body: "first", filename: "ubik.txt", format: "" },
        { body: "second", filename: "other.txt", format: "" },
      ],
    })
  );
  await be_in_folder(detachFolder);
  aboutMessage = get_about_message();
  await select_click_row(0);
  aboutMessage.toggleAttachmentList(true);
  for (const attachment of aboutMessage.currentAttachments) {
    await attachment.isEmpty();
  }

  const detachDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  detachDir.append("detach-all-decline");
  if (detachDir.exists()) {
    detachDir.remove(true);
  }
  detachDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  registerCleanupFunction(() => detachDir.remove(true));
  const existingPath = PathUtils.join(detachDir.path, "ubik.txt");
  await IOUtils.writeUTF8(existingPath, "existing");

  MockFilePicker.init();
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  MockFilePicker.useDirectory(detachDir.path);
  const replacePrompt = BrowserTestUtils.promiseAlertDialogOpen("cancel");
  aboutMessage.goDoCommand("cmd_detachAllAttachments");
  await replacePrompt;
  await BrowserTestUtils.promiseAlertDialogOpen("accept");
  MockFilePicker.cleanup();

  const detachedPath = PathUtils.join(detachDir.path, "other.txt");
  await TestUtils.waitForCondition(
    () =>
      [existingPath, detachedPath].every(path =>
        aboutMessage.currentAttachments?.some(
          a => a.url == PathUtils.toFileURI(path)
        )
      ),
    "the detached attachments should link to their files"
  );
  Assert.equal(
    await IOUtils.readUTF8(existingPath),
    "existing",
    "The existing file should not have been replaced"
  );
  Assert.equal(
    await IOUtils.readUTF8(detachedPath),
    "second",
    "The other attachment should have been saved"
  );
});

/**
 * Tests that the detach and delete attachment menu items are disabled for .eml
 * files.
 */
add_task(async function test_attachment_menus_eml_file() {
  const file = new FileUtils.File(
    getTestFilePath("data/multiple_attachments.eml")
  );
  const msgc = await open_message_from_file(file);
  aboutMessage = get_about_message(msgc);

  aboutMessage.toggleAttachmentList(true);
  const menuStates = { open: true, save: true, detach: false, delete_: false };
  await check_toolbar_menu_states_multiple(menuStates);
  await check_menu_states_all(menuStates);
  await check_menu_states_single(0, menuStates);
  await check_menu_states_single(1, menuStates);

  // Test Save All.
  const tmpD = Services.dirsvc.get("TmpD", Ci.nsIFile);
  const saveDir = tmpD.clone();
  saveDir.append("multi-save");
  if (saveDir.exists()) {
    saveDir.remove(true);
  }
  saveDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const existing = tmpD.clone();
  existing.append("multi-save");
  existing.append("ubik.txt");
  existing.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o755);
  MockFilePicker.init(aboutMessage.browsingContext);
  const filePickerShownPromise = new Promise(resolve => {
    MockFilePicker.showCallback = () => {
      Assert.ok(true, "Filepicker shown.");
      MockFilePicker.useDirectory([saveDir.path]);
      resolve();
    };
  });
  registerCleanupFunction(() => {
    saveDir.remove(true);
    MockFilePicker.cleanup();
  });
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  const alertPromise = BrowserTestUtils.promiseAlertDialogOpen(
    "",
    "chrome://global/content/commonDialog.xhtml",
    {
      async callback(win) {
        win.document.querySelector("dialog").acceptDialog();
      },
    }
  );
  const saved = BrowserTestUtils.waitForEvent(msgc, "attachmentsSaved");
  EventUtils.synthesizeMouseAtCenter(
    aboutMessage.document.getElementById("attachmentSaveAllMultiple"),
    {},
    aboutMessage
  );
  await filePickerShownPromise;
  await alertPromise; // Get dialog to confirm replace, and hit Ok.
  await saved;
  Assert.greater(
    (await IOUtils.stat(existing.path)).size,
    0,
    "Existing file should have been replaced"
  );
  Assert.equal(
    (await IOUtils.getChildren(saveDir.path)).length,
    2,
    "Both attachments should have been saved"
  );

  await BrowserTestUtils.closeWindow(msgc);

  Assert.report(
    false,
    undefined,
    undefined,
    "Test ran to completion successfully"
  );
});

registerCleanupFunction(() => {
  // Remove created folders.
  folder.deleteSelf(null);
});

/**
 * Creates two stored copies with the same Message-ID and distinct attachments.
 *
 * @param {string} name - Unique folder prefix.
 * @param {number} [partCount=1] - One or two real displayed attachment parts.
 * @returns {Promise<object>} Selected attachment, physical headers and folders.
 */
async function selectedDetachFixture(name, partCount = 1) {
  const folders = [];
  const headers = [];
  for (const index of [0, 1]) {
    const created = await create_folder(name + index);
    registerCleanupFunction(async () => {
      const tabmail = document.getElementById("tabmail");
      const mailTab = tabmail.tabInfo.find(
        tab => tab.mode.name == "mail3PaneTab"
      );
      Assert.ok(mailTab, "Owned source cleanup retains a live mail tab");
      tabmail.switchToTab(mailTab);
      const {
        get_about_3pane,
        get_about_message: cleanupGetAboutMessage,
        select_none,
        wait_for_blank_content_pane,
      } = ChromeUtils.importESModule(
        "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
      );
      const { MailServices } = ChromeUtils.importESModule(
        "resource:///modules/MailServices.sys.mjs"
      );
      const pane = get_about_3pane();
      const reader = cleanupGetAboutMessage();
      if (
        pane.gFolder == created ||
        (reader.gMessageURI && reader.gFolder == created)
      ) {
        if (pane.gDBView?.selection) {
          await select_none();
        } else {
          reader.displayMessage();
          await wait_for_blank_content_pane();
        }
        await be_in_folder(MailServices.accounts.localFoldersServer.rootFolder);
      }
      created.deleteSelf(null);
    });
    const message = create_message({
      subject: name + index,
      attachments: [
        { body: "detach-copy-" + index, filename: "selected.txt", format: "" },
        ...(partCount == 2
          ? [
              {
                body: "second-copy-" + index,
                filename: "second.txt",
                format: "",
              },
            ]
          : []),
      ],
    });
    message.messageId = "same-detach-copy@example.invalid";
    await add_message_to_folder([created], message);
    folders.push(created);
    headers.push(Array.from(created.messages)[0]);
  }
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(service instanceof Ci.nsIDatabaseCore, native);
  Assert.equal(headers[0].messageId, headers[1].messageId);
  await be_in_folder(folders[1]);
  aboutMessage = get_about_message();
  await select_click_row(0);
  const attachment = aboutMessage.currentAttachments[0];
  Assert.equal(attachment.message.messageKey, headers[1].messageKey);
  Assert.equal(attachment.uri, folders[1].getUriForMsg(headers[1]));
  return {
    folders,
    headers,
    attachment,
    attachments: [...aboutMessage.currentAttachments],
  };
}

/**
 * Removes only fixture-owned download entries and their partial-data state.
 *
 * @param {string[]} paths - Exact target paths saved by this fixture.
 */
async function removeDetachDownloads(paths) {
  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs"
  );
  const list = await Downloads.getList(Downloads.ALL);
  for (const download of await list.getAll()) {
    if (paths.includes(download.target.path)) {
      await list.remove(download);
      await download.finalize(true);
    }
  }
}

/**
 * Reads the real stored parent through its ordinary local-only message service.
 *
 * @param {nsIMsgDBHdr} header - Selected physical header.
 * @returns {Promise<string>} The complete stored RFC822 message.
 */
async function readDetachParent(header) {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { PromiseTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
  );
  const uri = header.folder.getUriForMsg(header);
  const listener = new PromiseTestUtils.PromiseStreamListener();
  MailServices.messageServiceFromURI(uri).streamMessage(
    uri,
    listener,
    null,
    null,
    false,
    "",
    true
  );
  try {
    return await listener.promise;
  } finally {
    listener._stream?.close();
    listener._stream = null;
  }
}

/**
 * Checks strip and replacement-copy failures against a normally stored parent.
 * Faults use the native storage connection, without manufacturing message rows.
 */
async function assertNativeDetachFailureRollback() {
  const { folders, headers, attachment } =
    await selectedDetachFixture("DetachFailure");
  const selected = headers[1];
  const original = await readDetachParent(selected);
  const token = selected.storeToken;
  const flags = selected.flags;
  const core = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  const connection = core.connectionForTests;
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  // Every normal header remains real. Only its lower storage-property query is
  // faulted, so the command must preserve the native getter's actual nsresult.
  connection.executeSimpleSQL(
    "CREATE TEMP VIEW message_properties AS SELECT id,name,CASE WHEN id=" +
      selected.messageKey +
      " AND name='storeToken' THEN abs(-9223372036854775808) ELSE value END AS value FROM main.message_properties"
  );
  try {
    let expected;
    try {
      Reflect.get(selected, "storeToken");
    } catch (error) {
      expected = error.result;
    }
    Assert.ok(
      typeof expected == "number" && !Components.isSuccessCode(expected),
      "Native storage getter actually failed"
    );
    await Assert.rejects(
      AttachmentInfo.deleteAttachments(selected, [attachment]),
      error => error.result == expected,
      "Native preflight retains the reached original body-storage failure"
    );
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.message_properties");
  }
  Assert.equal(await readDetachParent(selected), original);
  Assert.equal(selected.storeToken, token);
  Assert.equal(selected.flags, flags);
  Assert.equal(folders[1].getTotalMessages(false), 1);
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "failed-selected-detach"
  );
  const target = PathUtils.join(dir, "selected.txt");
  const staging = async () =>
    (await IOUtils.getChildren(PathUtils.tempDir))
      .filter(p => PathUtils.filename(p).startsWith("tmp-msg"))
      .sort();
  const before = await staging();
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER attachment_copy_failure BEFORE INSERT ON main.messages WHEN NEW.folderId=" +
      folders[1].id +
      " BEGIN SELECT RAISE(ABORT,'attachment replacement copy failed'); END"
  );
  try {
    await Assert.rejects(
      AttachmentInfo.detachAttachments(selected, [attachment], dir),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT,
      "Replacement-copy terminal failure retains its native storage result"
    );
    Assert.deepEqual(
      await staging(),
      before,
      "Failed replacement removed its staging EML"
    );
    Assert.equal(
      await readDetachParent(selected),
      original,
      "Copy failure keeps the exact original body"
    );
    Assert.equal(selected.storeToken, token);
    Assert.equal(selected.flags, flags);
    Assert.ok(folders[1].msgDatabase.containsKey(selected.messageKey));
    Assert.equal(
      folders[1].getTotalMessages(false),
      1,
      "No replacement was published"
    );
    Assert.equal(
      folders[0].getTotalMessages(false),
      1,
      "Other physical copy was untouched"
    );
    Assert.equal(
      await IOUtils.readUTF8(target),
      "detach-copy-1",
      "A completed attachment save is still its actual selected bytes"
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER attachment_copy_failure");
    await removeDetachDownloads([target]);
    await IOUtils.remove(dir, { recursive: true });
    for (const path of await staging()) {
      if (!before.includes(path)) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  }
}

/**
 * Invalidates a real retained selection after actual replacement publication and
 * staging cleanup, before the consumer is allowed to delete the original.
 */
async function assertNativeDetachDeleteHandoff() {
  const { folders, headers, attachment } =
    await selectedDetachFixture("DetachHandoff");
  const selected = headers[1];
  const original = await readDetachParent(selected);
  const token = selected.storeToken;
  const flags = selected.flags;
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "detach-handoff"
  );
  const target = PathUtils.join(dir, "selected.txt");
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  const attachmentIO = Cu.getGlobalForObject(AttachmentInfo).IOUtils;
  Assert.ok(attachmentIO, "Observe the actual module's IO namespace");
  const remove = attachmentIO.remove;
  let changedAtHandoff = false;
  attachmentIO.remove = async function (path, options) {
    const result = await remove.call(attachmentIO, path, options);
    if (!changedAtHandoff && PathUtils.filename(path).startsWith("tmp-msg")) {
      Assert.equal(
        folders[1].getTotalMessages(false),
        2,
        "Actual replacement was published before staging cleanup finished"
      );
      attachment.message = headers[0];
      changedAtHandoff = true;
    }
    return result;
  };
  try {
    await Assert.rejects(
      AttachmentInfo.detachAttachments(selected, [attachment], dir),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "Changed selection refuses the destructive post-copy handoff"
    );
    Assert.ok(
      changedAtHandoff,
      "The real awaited staging cleanup reached the targeted handoff"
    );
    Assert.ok(folders[1].msgDatabase.containsKey(selected.messageKey));
    Assert.equal(
      await readDetachParent(selected),
      original,
      "The exact original body survives invalidation after copy"
    );
    Assert.equal(selected.storeToken, token);
    Assert.equal(selected.flags, flags);
    Assert.equal(
      folders[1].getTotalMessages(false),
      2,
      "Completed replacement and original are retained consistently on deletion refusal"
    );
    const replacement = Array.from(folders[1].messages).find(
      header => header.messageKey != selected.messageKey
    );
    Assert.ok(replacement);
    Assert.equal(replacement.folder, folders[1]);
    Assert.ok(
      (await readDetachParent(replacement)).includes(
        "X-Mozilla-External-Attachment-URL: " + PathUtils.toFileURI(target)
      )
    );
    Assert.equal(await IOUtils.readUTF8(target), "detach-copy-1");
    Assert.equal(
      folders[0].getTotalMessages(false),
      1,
      "Other real physical parent was untouched"
    );
  } finally {
    attachmentIO.remove = remove;
    attachment.message = selected;
    try {
      await removeDetachDownloads([target]);
    } finally {
      await IOUtils.remove(dir, { recursive: true, retryReadonly: true });
    }
  }
}

/**
 * Refuses saved-byte/body mismatch during the real confirmation and multi-save
 * intervals while preserving the currently stored physical parent.
 */
async function assertNativeDetachSavedBodyHandoff() {
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  for (const mode of ["confirmation", "multiSave"]) {
    const { folders, headers, attachment, attachments } =
      await selectedDetachFixture(
        "DetachSavedBody" + mode,
        mode == "multiSave" ? 2 : 1
      );
    const selected = headers[1];
    const original = await readDetachParent(selected);
    const storage = {
      token: selected.storeToken,
      size: selected.messageSize,
      offlineSize: selected.offlineMessageSize,
    };
    const donor = folders[1]
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .addMessage(
        original
          .replace("detach-copy-1", "changed-detach-body-longer")
          .replace("second-copy-1", "changed-second-body-longer")
      );
    const changedBody = await readDetachParent(donor);
    const change = () => {
      selected.storeToken = donor.storeToken;
      selected.messageSize = donor.messageSize;
      selected.offlineMessageSize = donor.offlineMessageSize;
    };
    const dir = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "saved-body-handoff"
    );
    const target = PathUtils.join(dir, "selected.txt");
    const laterTarget = PathUtils.join(dir, "second.txt");
    const laterSave = attachments[1]?.saveToFile;
    let changedDuringCommand = false;
    try {
      if (mode == "confirmation") {
        const pickerFactory = MockFilePicker.factory;
        Assert.ok(pickerFactory);
        MockFilePicker.reset();
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(target);
        MockFilePicker.setFiles([file]);
        MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;
        const confirmation = BrowserTestUtils.promiseAlertDialogOpen(
          "",
          "chrome://global/content/commonDialog.xhtml",
          {
            callback(win) {
              change();
              changedDuringCommand = true;
              win.document.querySelector("dialog").acceptDialog();
            },
          }
        );
        await Assert.rejects(
          attachment.detachFromMessage(aboutMessage.browsingContext),
          error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
          "Real confirmation cannot strip a different body from the saved bytes"
        );
        await confirmation;
        Assert.equal(MockFilePicker.factory, pickerFactory);
      } else {
        attachments[1].saveToFile = async function (...args) {
          change();
          changedDuringCommand = true;
          return laterSave.apply(this, args);
        };
        await Assert.rejects(
          AttachmentInfo.detachAttachments(selected, attachments, dir),
          error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
          "A later part save cannot replace the body consumed by an earlier save"
        );
        Assert.equal(
          await IOUtils.readUTF8(laterTarget),
          "changed-second-body-longer"
        );
      }
      Assert.ok(changedDuringCommand);
      Assert.equal(
        await IOUtils.readUTF8(target),
        "detach-copy-1",
        "Earlier output retains its actual original part bytes"
      );
      Assert.ok(folders[1].msgDatabase.containsKey(selected.messageKey));
      Assert.equal(
        await readDetachParent(selected),
        changedBody,
        "The changed current parent is retained, not stripped or deleted"
      );
      Assert.equal(
        folders[1].getTotalMessages(false),
        2,
        "No replacement was published"
      );
    } finally {
      if (attachments[1]) {
        attachments[1].saveToFile = laterSave;
      }
      if (mode == "confirmation") {
        MockFilePicker.reset();
      }
      if (folders[1].msgDatabase.containsKey(selected.messageKey)) {
        selected.storeToken = storage.token;
        selected.messageSize = storage.size;
        selected.offlineMessageSize = storage.offlineSize;
      }
      try {
        await removeDetachDownloads([target, laterTarget]);
      } finally {
        await IOUtils.remove(dir, { recursive: true, retryReadonly: true });
      }
    }
    Assert.equal(await readDetachParent(selected), original);
  }
}

add_task(async function test_nativeDetachKeepsSelectedPhysicalMessage() {
  const { folders, headers, attachment } =
    await selectedDetachFixture("NativeDetach");
  const firstToken = headers[0].storeToken;
  const selectedMessageId = headers[1].messageId;
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "selected-detach"
  );
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  try {
    await AttachmentInfo.detachAttachments(headers[1], [attachment], dir);
    Assert.equal(
      await IOUtils.readUTF8(PathUtils.join(dir, "selected.txt")),
      "detach-copy-1"
    );
    Assert.ok(
      !folders[1].msgDatabase.containsKey(headers[1].messageKey),
      "Original row was replaced after success"
    );
    Assert.equal(
      folders[1].getTotalMessages(false),
      1,
      "Exactly one replacement remains"
    );
    const replacement = Array.from(folders[1].messages)[0];
    Assert.equal(replacement.messageId, selectedMessageId);
    Assert.notEqual(replacement.messageKey, headers[1].messageKey);
    await select_click_row(0);
    Assert.equal(
      aboutMessage.currentAttachments[0].url,
      PathUtils.toFileURI(PathUtils.join(dir, "selected.txt"))
    );
    Assert.ok(folders[0].msgDatabase.containsKey(headers[0].messageKey));
    Assert.equal(headers[0].storeToken, firstToken);
    await be_in_folder(folders[0]);
    await select_click_row(0);
    Assert.equal(
      new TextDecoder().decode(
        await aboutMessage.currentAttachments[0].fetchAttachment()
      ),
      "detach-copy-0"
    );
  } finally {
    await removeDetachDownloads([PathUtils.join(dir, "selected.txt")]);
    await IOUtils.remove(dir, { recursive: true });
  }
});

add_task(async function test_attachmentDetachCancellationRetainsOriginal() {
  const { folders, headers, attachment } =
    await selectedDetachFixture("CancelDetach");
  const token = headers[1].storeToken;
  const bytes = new Uint8Array(await attachment.fetchAttachment());
  // The earlier EML task owns this registration until its deferred cleanup.
  // Reset per-command state without releasing or replacing that shared factory.
  const pickerFactory = MockFilePicker.factory;
  Assert.ok(pickerFactory, "The existing full-file picker owner is registered");
  MockFilePicker.reset();
  MockFilePicker.returnValue = Ci.nsIFilePicker.returnCancel;
  try {
    await attachment.detachFromMessage(aboutMessage.browsingContext);
    Assert.ok(MockFilePicker.shown, "Detach asked for its save destination");
  } finally {
    MockFilePicker.reset();
    Assert.equal(
      MockFilePicker.factory,
      pickerFactory,
      "Original picker teardown retains ownership"
    );
  }
  Assert.ok(folders[1].msgDatabase.containsKey(headers[1].messageKey));
  Assert.equal(headers[1].storeToken, token);
  Assert.deepEqual(new Uint8Array(await attachment.fetchAttachment()), bytes);
  Assert.equal(folders[1].getTotalMessages(false), 1);
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "cancel-selected-detach"
  );
  const target = PathUtils.join(dir, "selected.txt");
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(target);
  MockFilePicker.reset();
  MockFilePicker.setFiles([file]);
  MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;
  try {
    const confirmation = BrowserTestUtils.promiseAlertDialogOpen("cancel");
    const action = attachment.detachFromMessage(aboutMessage.browsingContext);
    await Promise.all([confirmation, action]);
    Assert.equal(await IOUtils.readUTF8(target), "detach-copy-1");
    Assert.ok(folders[1].msgDatabase.containsKey(headers[1].messageKey));
    Assert.equal(headers[1].storeToken, token);
    Assert.deepEqual(new Uint8Array(await attachment.fetchAttachment()), bytes);
    Assert.equal(
      folders[1].getTotalMessages(false),
      1,
      "Confirmation cancellation retains the original physical row"
    );
  } finally {
    MockFilePicker.reset();
    Assert.equal(
      MockFilePicker.factory,
      pickerFactory,
      "Original picker teardown retains ownership"
    );
    await removeDetachDownloads([target]);
    await IOUtils.remove(dir, { recursive: true });
  }
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  await Assert.rejects(
    AttachmentInfo.deleteAttachments(headers[0], [attachment]),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "A different physical parent cannot receive the selected detach command"
  );
  Assert.equal(folders[0].getTotalMessages(false), 1);
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    await assertNativeDetachFailureRollback();
    await assertNativeDetachDeleteHandoff();
    await assertNativeDetachSavedBodyHandoff();
  }
});

add_task(async function test_attachmentPermissionsAndEncryptionGatesRemain() {
  await selectedDetachFixture("PermissionDetach");
  Assert.ok(
    aboutMessage.CanDetachAttachments(),
    "Ordinary local attachment can detach"
  );
  const originalType = aboutMessage.currentHeaderData["content-type"];
  try {
    for (const type of [
      "application/pkcs7-mime",
      "application/x-pkcs7-signature",
    ]) {
      aboutMessage.currentHeaderData["content-type"] = { headerValue: type };
      Assert.ok(
        !aboutMessage.CanDetachAttachments(),
        "S/MIME detach remains blocked"
      );
    }
  } finally {
    aboutMessage.currentHeaderData["content-type"] = originalType;
  }
  const originalSecurity = aboutMessage.Enigmail.msg.securityInfo;
  const { EnigmailConstants } = ChromeUtils.importESModule(
    "chrome://openpgp/content/modules/constants.sys.mjs"
  );
  try {
    for (const statusFlags of [
      EnigmailConstants.PGP_MIME_SIGNED,
      EnigmailConstants.PGP_MIME_ENCRYPTED,
    ]) {
      aboutMessage.Enigmail.msg.securityInfo = { statusFlags };
      Assert.ok(
        !aboutMessage.CanDetachAttachments(),
        "The real OpenPGP gate refuses signed/encrypted state"
      );
    }
  } finally {
    aboutMessage.Enigmail.msg.securityInfo = originalSecurity;
  }
  const { AttachmentInfo } = ChromeUtils.importESModule(
    "resource:///modules/AttachmentInfo.sys.mjs"
  );
  await Assert.rejects(
    AttachmentInfo.stripAttachments(
      { folder: { canDeleteMessages: false, URI: "denied" } },
      new Map(),
      "DETACH"
    ),
    /Cannot delete messages/,
    "Existing delete permission remains enforced"
  );
  await Assert.rejects(
    AttachmentInfo.stripAttachments(
      {
        folder: {
          canDeleteMessages: true,
          canFileMessages: false,
          URI: "denied",
        },
      },
      new Map(),
      "DETACH"
    ),
    /Cannot file messages/,
    "Existing file permission remains enforced"
  );
});

/** Record the remaining native animation owner without changing UI state. */
add_task(function record_attachment_cleanup_animation_owner() {
  registerCleanupFunction(() => {
    const tabmail = document.getElementById("tabmail");
    const mailTab = tabmail.tabInfo.find(
      tab => tab.mode.name == "mail3PaneTab"
    );
    const pane = mailTab?.chromeBrowser.contentWindow;
    const reader = pane?.messageBrowser.contentWindow;
    const documents = [
      ["chrome", document],
      ["three-pane", pane?.document],
      ["message", reader?.document],
    ];
    info(
      "ATTACHMENT_CLEANUP_ANIMATION_OWNER " +
        JSON.stringify({
          native: Services.prefs.getBoolPref("mail.panorama.enabled", false),
          vsync: ChromeUtils.vsyncEnabled(),
          feedback: {
            started: window.MsgStatusFeedback._startRequests,
            spinning: window.MsgStatusFeedback._meteorsSpinning,
            startPending: window.MsgStatusFeedback._startTimeoutID != null,
            stopPending: window.MsgStatusFeedback._stopTimeoutID != null,
          },
          documents: documents.map(([label, doc]) => ({
            label,
            uri: doc?.documentURI,
            animations: (doc?.getAnimations() ?? []).map(animation => ({
              name: animation.animationName,
              state: animation.playState,
              target: animation.effect?.target?.localName,
              id: animation.effect?.target?.id,
              classes: String(animation.effect?.target?.className ?? ""),
            })),
          })),
          tabs: tabmail.tabInfo.map(tab => ({
            mode: tab.mode.name,
            busy: tab.busy,
            uri: tab.browser?.currentURI?.spec,
          })),
          message: {
            uri: reader?.gMessageURI,
            loading:
              reader?.getMessagePaneBrowser()?.webProgress.isLoadingDocument,
            browserURI: reader?.getMessagePaneBrowser()?.currentURI.spec,
          },
        })
    );
  });
});

// Register at file evaluation, before fixture cleanup is registered by tasks.
// The generic blank-pane helper skips hidden browsers; owned loads must finish
// before their folders and servers are removed, even after the pane is hidden.
registerCleanupFunction(async function finishOwnedHiddenAttachmentReader() {
  const tabmail = document.getElementById("tabmail");
  const mailTab = tabmail.tabInfo.find(tab => tab.mode.name == "mail3PaneTab");
  Assert.ok(mailTab, "Owned reader cleanup retains its mail tab");
  tabmail.switchToTab(mailTab);
  const { MailServices: readerMailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  await be_in_folder(readerMailServices.accounts.localFoldersServer.rootFolder);
  const pane = mailTab.chromeBrowser.contentWindow;
  const reader = pane.messageBrowser.contentWindow;
  const browser = reader.getMessagePaneBrowser();
  reader.displayMessage();
  // Start a real navigation even if currentURI is blank while an older load
  // is still pending. loadAboutBlank otherwise returns early in that state.
  await BrowserTestUtils.loadURIString({ browser, uriString: "about:blank" });
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI.spec == "about:blank" &&
      !browser.webProgress.isLoadingDocument,
    "The owned hidden attachment reader reaches its real blank terminal"
  );
  Assert.equal(browser.currentURI.spec, "about:blank");
  Assert.ok(!browser.webProgress.isLoadingDocument);
  info("ATTACHMENT_HIDDEN_READER_TERMINAL " + browser.currentURI.spec);

  // Queue the observational detail after all already registered fixture
  // teardown. Do not finish, cancel or otherwise alter any animation.
  registerCleanupFunction(() => {
    const animations = pane.document.getAnimations();
    info(
      "ATTACHMENT_CLEANUP_ANIMATION_DETAILS " +
        JSON.stringify({
          vsync: ChromeUtils.vsyncEnabled(),
          feedbackStarts: window.MsgStatusFeedback._startRequests,
          spinning: window.MsgStatusFeedback._meteorsSpinning,
          animationCount: animations.length,
          animations: animations.map(animation => ({
            kind: animation.constructor.name,
            name: animation.animationName,
            transition: animation.transitionProperty,
            state: animation.playState,
            timing: animation.effect?.getComputedTiming(),
            target: animation.effect?.target?.localName,
            classes: String(animation.effect?.target?.className ?? ""),
            parentId: animation.effect?.target?.parentElement?.id,
            ancestorId: animation.effect?.target?.closest?.("[id]")?.id,
            shadowHost:
              animation.effect?.target?.getRootNode?.().host?.localName,
          })),
          browserURI: browser.currentURI.spec,
          loading: browser.webProgress.isLoadingDocument,
        })
    );
  });
});

// Identify the retained standard activity after normal owned teardown. This
// observes the real producer; it does not complete, cancel or remove activities.
registerCleanupFunction(() => {
  registerCleanupFunction(() => {
    const feedback = window.MsgStatusFeedback;
    info(
      "ATTACHMENT_CLEANUP_ACTIVITY_OWNER " +
        JSON.stringify({
          native: Services.prefs.getBoolPref("mail.panorama.enabled", false),
          indexerEnabled: Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled",
            false
          ),
          starts: feedback._startRequests,
          spinning: feedback._meteorsSpinning,
          activities: feedback._activeProcesses.map(activity => ({
            id: activity.id,
            state: activity.state,
            paused: activity.state == Ci.nsIActivityProcess.STATE_PAUSED,
            running: activity.state == Ci.nsIActivityProcess.STATE_INPROGRESS,
            displayText: activity.displayText,
            lastStatusText: activity.lastStatusText,
            contextType: activity.contextType,
            contextObj: String(activity.contextObj),
            percentComplete: activity.percentComplete,
          })),
        })
    );
  });
});

/** Exercise the real Activity Manager's progress-state notifications. */
add_task(async function test_activityFeedbackTracksRunningStatesAndOverlap() {
  const tabmail = document.getElementById("tabmail");
  const mailTab = tabmail.tabInfo.find(tab => tab.mode.name == "mail3PaneTab");
  Assert.ok(mailTab, "Activity controls retain the real mail tab");
  tabmail.switchToTab(mailTab);
  const { MailServices: activityMailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  await be_in_folder(
    activityMailServices.accounts.localFoldersServer.rootFolder
  );
  const reader =
    mailTab.chromeBrowser.contentWindow.messageBrowser.contentWindow;
  const browser = reader.getMessagePaneBrowser();
  reader.displayMessage();
  await BrowserTestUtils.loadURIString({ browser, uriString: "about:blank" });
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI.spec == "about:blank" &&
      !browser.webProgress.isLoadingDocument,
    "Real message requests settle before the independent activity controls"
  );

  const feedback = window.MsgStatusFeedback;
  const baseline = feedback._startRequests;
  const panel = document.getElementById("statusbar-progresspanel");
  Assert.ok(panel, "The real status progress panel exists");
  const fixtureActivityManager = Cc[
    "@mozilla.org/activity-manager;1"
  ].getService(Ci.nsIActivityManager);
  const activityStates = Ci.nsIActivityProcess;
  /** @type {Set<nsIActivityProcess>} */
  const ownedProcesses = new Set();

  /**
   * Publishes a test-owned standard process in its supplied initial state.
   *
   * @param {number} initialState - A valid nsIActivityProcess state.
   * @param {string} description - The temporary process description.
   * @returns {nsIActivityProcess} The registered process.
   * @throws {nsIException} If the supplied initial state is invalid.
   */
  function makeFixtureActivity(initialState, description) {
    const activity = Cc["@mozilla.org/activity-process;1"].createInstance(
      Ci.nsIActivityProcess
    );
    activity.init(description, "S3-76 temporary activity control");
    activity.contextType = "s376-owned-activity-control";
    activity.contextObj = description;
    ownedProcesses.add(activity);
    activity.state = initialState;
    fixtureActivityManager.addActivity(activity);
    return activity;
  }

  /**
   * Waits for the progress panel's rendered visibility after a real state change.
   *
   * @param {boolean} visible - The expected rendered visibility.
   * @returns {Promise<void>} Resolves when the panel reaches that visibility.
   */
  async function waitForActivityProgress(visible) {
    await BrowserTestUtils.waitForMutationCondition(
      panel,
      { attributes: true, attributeFilter: ["hidden"] },
      () => BrowserTestUtils.isVisible(panel) == visible
    );
    Assert.equal(BrowserTestUtils.isVisible(panel), visible);
  }

  await waitForActivityProgress(baseline > 0);
  let operationError;
  const cleanupErrors = [];
  try {
    for (const [initialState, description] of [
      [activityStates.STATE_PAUSED, "Initially paused"],
      [activityStates.STATE_WAITINGFORINPUT, "Initially waiting for input"],
      [activityStates.STATE_WAITINGFORRETRY, "Initially waiting for retry"],
    ]) {
      const activity = makeFixtureActivity(initialState, description);
      Assert.equal(feedback._startRequests, baseline, description);
      Assert.ok(
        feedback._activeProcesses.includes(activity),
        "A nonterminal inactive process stays subscribed for resume"
      );
      activity.state = activityStates.STATE_INPROGRESS;
      Assert.equal(feedback._startRequests, baseline + 1);
      await waitForActivityProgress(true);
      activity.state = initialState;
      Assert.equal(feedback._startRequests, baseline);
      await waitForActivityProgress(baseline > 0);
      activity.state = activityStates.STATE_INPROGRESS;
      Assert.equal(feedback._startRequests, baseline + 1);
      activity.state = activityStates.STATE_COMPLETED;
      Assert.equal(feedback._startRequests, baseline);
      Assert.ok(!feedback._activeProcesses.includes(activity));
      fixtureActivityManager.removeActivity(activity.id);
      Assert.equal(
        feedback._startRequests,
        baseline,
        "Terminal removal is balanced"
      );
    }

    for (const terminalState of [
      activityStates.STATE_COMPLETED,
      activityStates.STATE_CANCELED,
    ]) {
      const activity = makeFixtureActivity(terminalState, "Already terminal");
      Assert.equal(feedback._startRequests, baseline);
      Assert.ok(!feedback._activeProcesses.includes(activity));
      fixtureActivityManager.removeActivity(activity.id);
      Assert.equal(feedback._startRequests, baseline);
    }

    const first = makeFixtureActivity(
      activityStates.STATE_INPROGRESS,
      "First running"
    );
    Assert.equal(feedback._startRequests, baseline + 1);
    first.state = activityStates.STATE_INPROGRESS;
    Assert.equal(
      feedback._startRequests,
      baseline + 1,
      "Repeated state is idempotent"
    );
    const second = makeFixtureActivity(
      activityStates.STATE_INPROGRESS,
      "Second running"
    );
    Assert.equal(feedback._startRequests, baseline + 2);
    await waitForActivityProgress(true);
    first.state = activityStates.STATE_PAUSED;
    Assert.equal(feedback._startRequests, baseline + 1);
    Assert.ok(
      BrowserTestUtils.isVisible(panel),
      "Other running work keeps progress visible"
    );
    first.state = activityStates.STATE_INPROGRESS;
    Assert.equal(
      feedback._startRequests,
      baseline + 2,
      "Resume restores only its own busy request"
    );
    second.state = activityStates.STATE_PAUSED;
    Assert.equal(feedback._startRequests, baseline + 1);
    first.state = activityStates.STATE_PAUSED;
    Assert.equal(feedback._startRequests, baseline);
    second.state = activityStates.STATE_INPROGRESS;
    Assert.equal(feedback._startRequests, baseline + 1);
    fixtureActivityManager.removeActivity(first.id);
    Assert.equal(
      feedback._startRequests,
      baseline + 1,
      "Removing paused work retains other busy work"
    );
    Assert.ok(!feedback._activeProcesses.includes(first));
    first.state = activityStates.STATE_INPROGRESS;
    Assert.equal(
      feedback._startRequests,
      baseline + 1,
      "Removed process no longer notifies the window"
    );
    second.state = activityStates.STATE_CANCELED;
    Assert.equal(feedback._startRequests, baseline);
    Assert.ok(!feedback._activeProcesses.includes(second));
    fixtureActivityManager.removeActivity(second.id);
  } catch (error) {
    operationError = error;
  } finally {
    // Dispose only the standard processes created by this test. The actual
    // paused native search activity and every unrelated process remain intact.
    for (const activity of ownedProcesses) {
      try {
        const registered = fixtureActivityManager.getActivity(activity.id);
        if (registered && registered != activity) {
          cleanupErrors.push(
            new Error("Temporary activity identity changed before cleanup")
          );
          continue;
        }
        if (
          activity.state != activityStates.STATE_COMPLETED &&
          activity.state != activityStates.STATE_CANCELED
        ) {
          activity.state = activityStates.STATE_CANCELED;
        }
        if (registered) {
          fixtureActivityManager.removeActivity(activity.id);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
      "Activity operation or owned cleanup failed"
    );
  }
  if (operationError) {
    throw operationError;
  }
  Assert.equal(
    feedback._startRequests,
    baseline,
    "Temporary controls restore busy accounting"
  );
  await waitForActivityProgress(baseline > 0);
});
