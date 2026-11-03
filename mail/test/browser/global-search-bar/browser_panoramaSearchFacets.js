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
  for (let i = 0; i < 100; i++) {
    matches.push(
      first.addMessage(
        generator.makeMessage({ subject: term }).toMessageString()
      )
    );
  }
  excluded.addMessage(
    generator
      .makeMessage({ subject: "Unrelated local control" })
      .toMessageString()
  );
  first.addKeywordsToMessages([clicked], "$label1");
  first.addKeywordsToMessages([matches[2]], "not-a-ui-tag");
  second.addKeywordsToMessages([secondCopy], "$label1");
  first.markMessagesFlagged([clicked], true);
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

add_task(
  async function test_quickFilterFacetEscalationRetainsPhysicalMembers() {
    await be_in_folder(fixture.excluded);
    const origin = tabmail.currentTabInfo;
    const pane = origin.chromeBrowser.contentWindow;
    const visible = pane.quickFilterBar.filterer.visible;
    pane.commandController.doCommand("cmd_showQuickFilterBar");
    registerCleanupFunction(() => {
      pane.commandController.doCommand("cmd_resetQuickFilterBar");
      if (pane.quickFilterBar.filterer.visible != visible) {
        pane.commandController.doCommand("cmd_toggleQuickFilterBar");
      }
    });
    await set_filter_text(fixture.term);
    Assert.equal(
      pane.gDBView.numMsgsInView,
      0,
      "Local filter excludes every global hit"
    );
    pane.document.getElementById("qfb-qs-textbox").dispatchEvent(
      new pane.CustomEvent("search", {
        detail: fixture.term,
        cancelable: true,
      })
    );
    const tab = tabmail.currentTabInfo;
    Assert.equal(
      tab.mode.name,
      "glodaFacet",
      "Preserve the user's facet preference"
    );
    Assert.equal(
      tab.mailSearch.text,
      fixture.term,
      "Use the native query argument"
    );
    await TestUtils.waitForCondition(() => tab.searchPromise);
    await tab.searchPromise;
    const context = tab.browser.contentWindow.FacetContext;
    Assert.equal(
      context.fullSet.length,
      102,
      "All physical hits across query pages count"
    );
    Assert.deepEqual(
      context.fullSet.map(item => Number(item.id)).sort((a, b) => a - b),
      fixture.matches.map(header => header.messageKey).sort((a, b) => a - b)
    );
    const results = tab.browser.contentDocument.getElementById("results");
    Assert.equal(
      JSON.parse(results.countNode.getAttribute("data-l10n-args")).n,
      102
    );
    const tag = context.faceters.find(faceter => faceter.field == "tags");
    Assert.ok(
      tag.orderedGroups.every(([value]) => value?.id != "not-a-ui-tag"),
      "Arbitrary native keywords do not become user-visible tags"
    );
    const group = tag.orderedGroups.find(
      ([value]) => value?.id == "$label1"
    )[0];
    context.addFacetConstraint(tag, true, [group], false, false);
    Assert.equal(
      context.activeSet.length,
      2,
      "Two physical copies with one Message-ID remain distinct"
    );
    const row = tab.browser.contentDocument.querySelector(
      "facet-result-message"
    );
    Assert.equal(row.author.textContent, "Reply Sender");
    Assert.equal(row.author.title, "facetreply@example.invalid");
    Assert.deepEqual(
      Array.from(
        row.querySelectorAll(".message-attachment"),
        node => node.textContent
      ),
      ["retained.pdf", "retained.png"]
    );
    const people = context.faceters.find(
      faceter => faceter.field == "participants"
    );
    const participant = people.orderedGroups.find(
      ([value]) => value?.id == "facetreply@example.invalid"
    )[0];
    context.addFacetConstraint(people, true, [participant], false, false);
    Assert.equal(
      context.activeSet.length,
      2,
      "People refinement uses the same physical members"
    );
    context.removeFacetConstraint(people, true, [participant]);
    const star = context.faceters.find(faceter => faceter.field == "starred");
    context.addFacetConstraint(star, true, [true], false, false);
    Assert.deepEqual(
      context.activeSet.map(item => Number(item.id)),
      [fixture.clicked.messageKey]
    );
    context.removeFacetConstraint(star, true, [true]);
    const attachments = context.faceters.find(
      faceter => faceter.field == "attachmentCategories"
    );
    Assert.equal(
      attachments.xblNode.countNode.textContent,
      "2",
      "One physical message with two categories counts once per copy"
    );
    const category = attachments.orderedGroups.find(
      ([value]) => value?.id == "pdf"
    )[0];
    context.addFacetConstraint(attachments, true, [category], false, false);
    Assert.equal(
      context.activeSet.length,
      2,
      "Category refinement retains both actual copies"
    );
    context.removeFacetConstraint(attachments, true, [category]);
    const date = context.faceters.find(faceter => faceter.type == "date");
    context.addFacetConstraint(
      date,
      true,
      [
        [
          new Date(fixture.clicked.date / 1000),
          new Date(fixture.clicked.date / 1000),
        ],
      ],
      true,
      false
    );
    Assert.equal(
      context.activeSet.length,
      2,
      "Inclusive date bounds use the physical result dates"
    );
    context.removeFacetConstraint(
      date,
      true,
      date.constraint.groupValues.concat()
    );
    context.removeFacetConstraint(tag, true, [group]);
    const attachmentWidget = attachments.xblNode;
    EventUtils.synthesizeMouseAtCenter(
      attachmentWidget.bubble,
      {},
      tab.browser.contentWindow
    );
    Assert.equal(
      context.activeSet.length,
      2,
      "Attachment checkbox uses proven physical presence"
    );
    attachmentWidget.filterNode.value =
      attachmentWidget.realTrueGroups.findIndex(value => value.id == "pdf");
    attachmentWidget.filterNode.dispatchEvent(
      new tab.browser.contentWindow.Event("change")
    );
    Assert.equal(context.activeSet.length, 2);
    EventUtils.synthesizeMouseAtCenter(
      attachmentWidget.bubble,
      {},
      tab.browser.contentWindow
    );
    Assert.equal(
      context.activeSet.length,
      102,
      "Unchecking clears the category and any-attachment constraint"
    );
    Assert.equal(attachments.constraint, null);
    context.addFacetConstraint(tag, true, [group], false, false);
    const list = await context.showActiveSetInTab();
    Assert.deepEqual(
      (await readNativeList(list)).identities,
      [fixture.clicked, fixture.secondCopy].map(physicalIdentity).sort()
    );
    tabmail.closeTab(list);
    tabmail.closeTab(tab);
    Assert.equal(tabmail.currentTabInfo, origin);
    Assert.equal(
      pane.quickFilterBar.filterer.filterValues.text.text,
      fixture.term
    );
    Assert.equal(
      pane.gDBView.numMsgsInView,
      0,
      "Escalation keeps the original folder and filter"
    );
    pane.commandController.doCommand("cmd_resetQuickFilterBar");
  }
);

add_task(
  async function test_facetConversationOpensCompleteThreadAndSelectedCopy() {
    const { tab, context } = await openNativeFacets(fixture.term);
    const message = context.fullSet.find(
      item => Number(item.id) == fixture.clicked.messageKey
    );
    const list = await context.openMailSearchConversation(message, true);
    Assert.ok(
      list,
      "The supplied native conversation facade opens an existing list"
    );
    const { pane, identities } = await readNativeList(list);
    Assert.deepEqual(
      identities,
      fixture.conversation.map(physicalIdentity).sort(),
      "Include non-matching root/tail and both physical Message-ID copies"
    );
    await TestUtils.waitForCondition(() => pane.gDBView.numSelected == 1);
    Assert.equal(
      physicalIdentity(pane.gDBView.hdrForFirstSelectedMessage),
      physicalIdentity(fixture.clicked),
      "The clicked folder/key is selected after asynchronous row delivery"
    );
    Assert.equal(
      tabmail.currentTabInfo,
      tab,
      "Background opening retains the facet tab"
    );
    tabmail.closeTab(list);
    tabmail.closeTab(tab);
  }
);

add_task(async function test_nativeFacetInputKeepsItsBackend() {
  const { tab } = await openNativeFacets(fixture.term);
  const input = tab.panel.querySelector(".remote-gloda-search");
  input.value = "nativefacetinputnomatches";
  input.doSearch();
  const replacement = tabmail.currentTabInfo;
  Assert.notEqual(replacement, tab);
  Assert.equal(replacement.mode.name, "glodaFacet");
  Assert.equal(replacement.mailSearch.text, "nativefacetinputnomatches");
  await TestUtils.waitForCondition(() => replacement.searchPromise);
  const result = await replacement.searchPromise;
  Assert.equal(
    result.items.length,
    0,
    "The retained input performs a real native query"
  );
  tabmail.closeTab(replacement);
});

add_task(
  async function test_openFacetCardChangesRefreshCurrentPhysicalCopies() {
    const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
      Ci.nsIAbCard
    );
    card.primaryEmail = "livefacetcard@example.invalid";
    card.displayName = "Open Facet Card A";
    let currentCard = book.addCard(card);
    const generator = new MessageGenerator();
    const term = "nativeopenfacetcardneedle";
    const raw = generator
      .makeMessage({
        subject: term,
        from: ["Facet Header Fallback", card.primaryEmail],
        attachments: [
          { filename: "live.pdf", contentType: "application/pdf", body: "pdf" },
        ],
      })
      .toMessageString();
    const headers = [
      fixture.first.addMessage(raw),
      fixture.second.addMessage(raw),
    ];
    const control = fixture.excluded.addMessage(
      generator
        .makeMessage({
          subject: term,
          from: ["Unrelated Facet Control", "unrelatedfacet@example.invalid"],
        })
        .toMessageString()
    );
    const expected = headers
      .map(header => [header.folder.id, header.messageKey, header.messageId])
      .sort();
    let tab;
    const originalCollect = fixture.service.collectResults;
    let release = () => {};
    try {
      const opened = await openNativeFacets(term);
      tab = opened.tab;
      const { context } = opened;
      const win = tab.browser.contentWindow;
      const doc = win.document;
      Assert.equal(context.fullSet.length, 3);
      Assert.ok(
        context.fullSet.some(item => item.id == String(control.messageKey))
      );
      const attachments = context.faceters.find(
        faceter => faceter.field == "attachmentCategories"
      );
      EventUtils.synthesizeMouseAtCenter(attachments.xblNode.bubble, {}, win);
      context.sortBy = "-date";
      const assertCurrent = name => {
        Assert.deepEqual(
          Array.from(context.activeSet, item => [
            item.location.folderId,
            Number(item.id),
            item.messageId,
          ]).sort(),
          expected,
          "The same refinement retains both independently known physical copies"
        );
        Assert.equal(context.tab.mailSearch.text, term);
        Assert.equal(context.sortBy, "-date");
        Assert.ok(
          context.faceters.find(
            faceter => faceter.field == "attachmentCategories"
          ).constraint
        );
        const authors = Array.from(
          doc.querySelectorAll(".message-author"),
          node => node.textContent
        );
        Assert.deepEqual(authors, [name, name]);
        Assert.ok(
          !context.activeSet.some(item => item.id == String(control.messageKey))
        );
      };
      assertCurrent("Open Facet Card A");
      const oldSet = context.mailSearchResultSet;
      const tabs = tabmail.tabInfo.length;
      currentCard.displayName = "Open Facet Card B";
      book.modifyCard(currentCard);
      await TestUtils.waitForCondition(
        () =>
          context.mailSearchResultSet != oldSet &&
          context.activeSet.length == 2 &&
          Array.from(doc.querySelectorAll(".message-author")).every(
            node => node.textContent == "Open Facet Card B"
          ),
        "The already-open facet refreshes after the real card notification"
      );
      await tab.searchPromise;
      Assert.equal(tabmail.tabInfo.length, tabs);
      assertCurrent("Open Facet Card B");
      Assert.ok(
        oldSet.items
          .filter(item => item.from[0]?.email == card.primaryEmail)
          .every(item => item.from[0].name == "Open Facet Card A"),
        "Earlier copied names remain snapshots"
      );

      const failure = new Error("Live facet refresh original failure");
      let observedError;
      const showError = context.showMailSearchError;
      context.showMailSearchError = function (id, error) {
        observedError = error;
        return showError.call(this, id, error);
      };
      fixture.service.collectResults = async () => {
        throw failure;
      };
      currentCard.displayName = "Open Facet Card C";
      book.modifyCard(currentCard);
      await TestUtils.waitForCondition(() => observedError);
      Assert.strictEqual(observedError, failure);
      Assert.equal(
        doc.getElementById("showLoading").getAttribute("data-l10n-id"),
        "facet-view-search-error"
      );
      Assert.equal(doc.querySelectorAll("facet-result-message").length, 0);
      Assert.equal(doc.getElementById("showEmpty").style.display, "none");
      context.showMailSearchError = showError;
      fixture.service.collectResults = originalCollect;
      book.deleteCards([currentCard]);
      currentCard = null;
      await TestUtils.waitForCondition(
        () =>
          context.mailSearchResultSet &&
          context.activeSet.length == 2 &&
          Array.from(doc.querySelectorAll(".message-author")).every(
            node => node.textContent == "Facet Header Fallback"
          ),
        "Deletion recovers the same open view with decoded-header fallback"
      );
      await tab.searchPromise;
      assertCurrent("Facet Header Fallback");
      const list = await context.showActiveSetInTab();
      const actual = await readNativeList(list);
      Assert.deepEqual(actual.identities, headers.map(physicalIdentity).sort());
      tabmail.closeTab(list);

      let collected = false;
      const held = new Promise(resolve => {
        release = resolve;
      });
      fixture.service.collectResults = async function (...args) {
        const result = await originalCollect.apply(this, args);
        collected = true;
        await held;
        return result;
      };
      currentCard = book.addCard(card);
      await TestUtils.waitForCondition(
        () => collected,
        "A later real card notification starts one refresh"
      );
      const pending = tab.searchPromise;
      tabmail.closeTab(tab);
      tab = null;
      const remaining = tabmail.tabInfo.length;
      release();
      Assert.equal(
        await pending,
        null,
        "Tab closure discards the in-flight refreshed snapshot"
      );
      Assert.equal(tabmail.tabInfo.length, remaining);
    } finally {
      release();
      fixture.service.collectResults = originalCollect;
      if (tab) {
        tabmail.closeTab(tab);
      }
      if (currentCard) {
        book.deleteCards([currentCard]);
      }
    }
  }
);

add_task(async function test_openFacetIdentityChangesRecomputeOwnAddresses() {
  const account = MailServices.accounts.createAccount();
  const identity = MailServices.accounts.createIdentity();
  identity.email = "openown@example.invalid";
  identity.replyTo = "Open Reply <openreply@example.invalid>";
  account.addIdentity(identity);
  const generator = new MessageGenerator();
  const term = "nativeopenidentityneedle";
  const raw = generator
    .makeMessage({
      subject: term,
      from: ["Own Sender", identity.email],
      to: [["Own Reply", "openreply@example.invalid"]],
    })
    .toMessageString();
  const headers = [
    fixture.first.addMessage(raw),
    fixture.second.addMessage(raw),
  ];
  const control = fixture.excluded.addMessage(
    generator
      .makeMessage({
        subject: term,
        from: ["Identity Control", "identitycontrol@example.invalid"],
        to: [["Other Recipient", "otherrecipient@example.invalid"]],
      })
      .toMessageString()
  );
  const expected = headers.map(header => String(header.messageKey)).sort();
  let tab;
  try {
    const opened = await openNativeFacets(term);
    tab = opened.tab;
    const { context } = opened;
    const win = tab.browser.contentWindow;
    const fromMe = () =>
      context.faceters.find(faceter => faceter.field == "fromMe");
    const toMe = () =>
      context.faceters.find(faceter => faceter.field == "toMe");
    const assertCopies = () => {
      Assert.deepEqual(
        Array.from(context.activeSet, item => item.id).sort(),
        expected
      );
      Assert.ok(
        !context.activeSet.some(item => item.id == String(control.messageKey))
      );
      Assert.equal(context.fullSet.length, 3);
    };
    const tabs = tabmail.tabInfo.length;
    EventUtils.synthesizeMouseAtCenter(fromMe().xblNode.bubble, {}, win);
    assertCopies();
    identity.email = "changedown@example.invalid";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 0,
      "Actual email setter updates the already-open fromMe refinement"
    );
    await tab.searchPromise;
    Assert.ok(
      fromMe().constraint,
      "Empty current membership keeps the selected refinement"
    );
    Assert.ok(fromMe().xblNode.checked);
    identity.email = "openown@example.invalid";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 2
    );
    await tab.searchPromise;
    assertCopies();
    EventUtils.synthesizeMouseAtCenter(fromMe().xblNode.bubble, {}, win);
    Assert.equal(context.activeSet.length, 3);
    EventUtils.synthesizeMouseAtCenter(toMe().xblNode.bubble, {}, win);
    assertCopies();
    identity.replyTo = "Changed Reply <changedreply@example.invalid>";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 0,
      "Actual Reply-To setter updates current toMe membership"
    );
    await tab.searchPromise;
    Assert.ok(toMe().constraint);
    Assert.ok(toMe().xblNode.checked);
    identity.replyTo = "Open Reply <openreply@example.invalid>";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 2
    );
    await tab.searchPromise;
    assertCopies();
    Assert.equal(
      tabmail.tabInfo.length,
      tabs,
      "Identity changes never open another query tab"
    );
    const people = context.faceters.find(
      faceter => faceter.field == "participants"
    );
    Assert.ok(
      !people.orderedGroups.some(([value]) =>
        ["openown@example.invalid", "openreply@example.invalid"].includes(
          value?.id
        )
      ),
      "Current own addresses are omitted from the people facet"
    );
  } finally {
    if (tab) {
      tabmail.closeTab(tab);
    }
    MailServices.accounts.removeAccount(account);
  }
});

add_task(async function test_replacedFacetQueryCannotInstallOldResults() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const original = fixture.service.collectResults;
  let release;
  let collected = false;
  const held = new Promise(resolve => {
    release = resolve;
  });
  fixture.service.collectResults = async function (...args) {
    const results = await original.apply(this, args);
    collected = true;
    await held;
    return results;
  };
  try {
    const old = context.loadMailSearch();
    await TestUtils.waitForCondition(() => collected);
    fixture.service.collectResults = original;
    tab.mailSearch.text = "nomatchreplacementfacetquery";
    await context.loadMailSearch();
    release();
    Assert.equal(
      await old,
      null,
      "Observe and discard the old completed query"
    );
    Assert.equal(context.fullSet.length, 0);
    Assert.equal(context.activeSet.length, 0);
    Assert.equal(
      tab.browser.contentDocument.getElementById("showEmpty").style.display,
      "block"
    );
    Assert.notEqual(
      tab.browser.contentDocument
        .getElementById("showLoading")
        .getAttribute("data-l10n-id"),
      "facet-view-search-error",
      "Cancellation is not an error or old-result success"
    );
  } finally {
    release();
    fixture.service.collectResults = original;
    tabmail.closeTab(tab);
  }
});

add_task(async function test_facetQueryFailureIsNotAnEmptySuccess() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const original = fixture.service.collectResults;
  fixture.service.collectResults = async () => {
    throw new Error("Facet query failure");
  };
  try {
    Assert.equal(await context.loadMailSearch(), null);
    Assert.equal(
      tab.browser.contentDocument
        .getElementById("showLoading")
        .getAttribute("data-l10n-id"),
      "facet-view-search-error"
    );
    Assert.equal(
      tab.browser.contentDocument.getElementById("showEmpty").style.display,
      "none"
    );
    Assert.equal(
      tab.browser.contentDocument.querySelectorAll("facet-result-message")
        .length,
      0
    );
  } finally {
    fixture.service.collectResults = original;
    tabmail.closeTab(tab);
  }
});

add_task(
  async function test_memberDeletedDuringConversationDeliveryClosesPartialList() {
    const { tab, context } = await openNativeFacets(fixture.term);
    const message = context.fullSet.find(
      item => Number(item.id) == fixture.clicked.messageKey
    );
    const tail = fixture.conversation.at(-1);
    const original = fixture.service.streamResultHeaders;
    fixture.service.streamResultHeaders = async function (...args) {
      const result = await original.apply(this, args);
      const key = tail.messageKey;
      fixture.second.deleteMessages([tail], null, true, false, null, false);
      await TestUtils.waitForCondition(
        () => !fixture.second.msgDatabase.containsKey(key),
        "The physical member is removed before search completion"
      );
      return result;
    };
    try {
      const list = await context.openMailSearchConversation(message, false);
      Assert.ok(list);
      await TestUtils.waitForCondition(
        () => !tabmail.tabInfo.includes(list),
        "A member removed before native completion cannot leave a partial successful conversation"
      );
      Assert.equal(tabmail.currentTabInfo, tab);
      Assert.equal(
        tab.browser.contentDocument
          .getElementById("showLoading")
          .getAttribute("data-l10n-id"),
        "facet-view-conversation-stale"
      );
      Assert.ok(
        fixture.first.msgDatabase.containsKey(fixture.clicked.messageKey),
        "The selected physical copy remains; the deleted member is a different row"
      );
      Assert.ok(!fixture.second.msgDatabase.containsKey(tail.messageKey));
    } finally {
      fixture.service.streamResultHeaders = original;
      tabmail.closeTab(tab);
    }
  }
);

add_task(async function test_closedFacetCannotOpenPendingConversation() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const message = context.fullSet.find(
    item => Number(item.id) == fixture.clicked.messageKey
  );
  const original = fixture.service.getConversation;
  let release;
  let captured = false;
  const held = new Promise(resolve => {
    release = resolve;
  });
  fixture.service.getConversation = async function (...args) {
    const snapshot = await original.apply(this, args);
    captured = true;
    await held;
    return snapshot;
  };
  try {
    const opening = context.openMailSearchConversation(message, false);
    await TestUtils.waitForCondition(() => captured);
    tabmail.closeTab(tab);
    const count = tabmail.tabInfo.length;
    release();
    Assert.equal(await opening, null);
    Assert.equal(
      tabmail.tabInfo.length,
      count,
      "No late list or single-message substitute opens"
    );
  } finally {
    release();
    fixture.service.getConversation = original;
    if (tabmail.tabInfo.includes(tab)) {
      tabmail.closeTab(tab);
    }
  }
});

add_task(async function test_deletedFacetCopyDoesNotOpenItsMessageIdPeer() {
  const { tab, context } = await openNativeFacets(fixture.term);
  const message = context.fullSet.find(
    item => Number(item.id) == fixture.clicked.messageKey
  );
  fixture.first.deleteMessages(
    [fixture.clicked],
    null,
    true,
    false,
    null,
    false
  );
  await TestUtils.waitForCondition(
    () => !fixture.first.msgDatabase.containsKey(fixture.clicked.messageKey),
    "The selected physical header was deleted from the actual store"
  );
  const count = tabmail.tabInfo.length;
  Assert.equal(await context.openMailSearchConversation(message, false), null);
  Assert.equal(tabmail.tabInfo.length, count);
  Assert.ok(
    fixture.second.msgDatabase.containsKey(fixture.secondCopy.messageKey),
    "The excluded peer substitution control still exists in the physical store"
  );
  Assert.equal(
    tab.browser.contentDocument
      .getElementById("showLoading")
      .getAttribute("data-l10n-id"),
    "facet-view-conversation-stale"
  );
  tabmail.closeTab(tab);
});
