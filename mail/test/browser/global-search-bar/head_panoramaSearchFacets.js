/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { GlodaMsgIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/IndexMsg.sys.mjs"
);
const { GlodaDatastore } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaDatastore.sys.mjs"
);
const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearch.sys.mjs"
);
const { be_in_folder } = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
const { set_filter_text } = ChromeUtils.importESModule(
  "resource://testing-common/mail/QuickFilterBarHelpers.sys.mjs"
);
const tabmail = document.getElementById("tabmail");
let fixture;

/**
 * Read independent physical identities from the actual store or native view.
 *
 * @param {nsIMsgDBHdr} header - Physical header.
 * @returns {string} Folder URI, global key and literal Message-ID.
 */
function physicalIdentity(header) {
  return JSON.stringify([
    header.folder.URI,
    header.messageKey,
    header.messageId,
  ]);
}

add_setup(async function setupNativeFacetMessages() {
  Assert.ok(
    Services.prefs.getBoolPref("mail.panorama.enabled"),
    "This suite requires the native backend selected at startup"
  );
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore,
    "The actual database service is Panorama"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["gloda.show_as_list_by_default", false],
      ["mailnews.default_view_flags", 0],
      ["mailnews.mark_message_read.auto", false],
    ],
  });
  const root =
    MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
  const folders = ["First", "Second", "Excluded"].map(name =>
    root
      .createLocalSubfolder("NativeFacet" + name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
  );
  registerCleanupFunction(async () => {
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }
    await closeMailSearch();
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
  });
  const [first, second, excluded] = folders;
  const generator = new MessageGenerator();
  const term = "panoramafacetedphysicalneedle";
  const parent = generator.makeMessage({
    subject: "Conversation root outside query",
    from: ["Root Sender", "facetsender@example.invalid"],
    to: [["Reply Sender", "facetreply@example.invalid"]],
  });
  const rootHeader = first.addMessage(parent.toMessageString());
  const reply = generator.makeMessage({
    inReplyTo: parent,
    subject: term,
    attachments: [
      { filename: "retained.pdf", contentType: "application/pdf", body: "pdf" },
      { filename: "retained.png", contentType: "image/png", body: "image" },
    ],
  });
  reply.subject = term;
  const secondCopy = second.addMessage(reply.toMessageString());
  const clicked = first.addMessage(reply.toMessageString());
  const tailMessage = generator.makeMessage({ inReplyTo: reply });
  tailMessage.subject = "Conversation tail outside query";
  const tail = second.addMessage(tailMessage.toMessageString());
  const matches = [secondCopy, clicked];
  // The ordinary batch API preserves header order and avoids one mailbox fsync
  // for every padding message in this pagination fixture.
  matches.push(
    ...first.addMessageBatch(
      Array.from({ length: 100 }, () =>
        generator.makeMessage({ subject: term }).toMessageString()
      )
    )
  );
  excluded.addMessage(
    generator
      .makeMessage({ subject: "Unrelated local control" })
      .toMessageString()
  );
  first.addKeywordsToMessages([clicked], "$label1");
  first.addKeywordsToMessages([matches[2]], "not-a-ui-tag");
  second.addKeywordsToMessages([secondCopy], "$label1");
  first.markMessagesFlagged([clicked], true);
  // This manifest keeps Gloda enabled. Its asynchronous commit writes gloda-id
  // on the same physical headers, so finish that fixture metadata before taking
  // the native index snapshot used by these UI assertions.
  await Promise.all(
    folders.map(
      folder =>
        new Promise((resolve, reject) => {
          const queued = GlodaMsgIndexer.indexFolder(folder, {
            force: true,
            callback(success) {
              if (!success) {
                reject(new Error("Fixture Gloda indexing did not complete"));
                return;
              }
              // The job callback runs inside the indexing transaction. Header
              // properties are published by the earlier post-commit callback.
              GlodaDatastore.runPostCommit(resolve);
            },
          });
          if (!queued) {
            reject(new Error("Fixture Gloda indexing was not queued"));
          }
        })
    )
  );
  const service = await getMailSearchService();
  let progress;
  do {
    progress = await service.update({ limit: 500 });
  } while (progress.moreWork);
  Assert.equal(first.getTotalMessages(false), 102);
  Assert.equal(second.getTotalMessages(false), 2);
  Assert.equal(excluded.getTotalMessages(false), 1);
  fixture = {
    first,
    second,
    excluded,
    term,
    matches,
    clicked,
    secondCopy,
    conversation: [rootHeader, secondCopy, clicked, tail],
    generator,
    service,
  };
});

/**
 * Open the existing facet tab and wait for its native query and widget build.
 *
 * @param {string} text - Literal search text.
 * @returns {Promise<object>} Existing tab and facet context.
 */
async function openNativeFacets(text) {
  // Earlier list selections may update native metadata; query the settled index.
  let progress;
  do {
    progress = await fixture.service.update({ limit: 500 });
  } while (progress.moreWork);
  const tab = tabmail.openTab("glodaFacet", { mailSearch: { text } });
  await TestUtils.waitForCondition(
    () => tab.searchPromise,
    "The retained facet document starts its native query"
  );
  await tab.searchPromise;
  return { tab, context: tab.browser.contentWindow.FacetContext };
}

/**
 * Read the actual completed C++ synthetic search view.
 *
 * @param {object} tab - Existing mail3PaneTab.
 * @returns {Promise<object>} Pane and physical rows.
 */
async function readNativeList(tab) {
  await TestUtils.waitForCondition(() => {
    const pane = tab.chromeBrowser?.contentWindow;
    return (
      pane?.gViewWrapper?.isSynthetic &&
      pane.dbViewWrapperListener.allMessagesLoaded
    );
  }, "Native synthetic list completes");
  const pane = tab.chromeBrowser.contentWindow;
  return {
    pane,
    identities: Array.from({ length: pane.gDBView.rowCount }, (_, index) =>
      physicalIdentity(pane.gDBView.getMsgHdrAt(index))
    ).sort(),
  };
}
