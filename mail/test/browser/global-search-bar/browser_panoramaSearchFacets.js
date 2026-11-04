/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

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
    // The real folder/filter setup can queue metadata projection work. The
    // global UI accepts one bounded update; finish fixture work before testing it.
    let progress;
    do {
      progress = await fixture.service.update({ limit: 500 });
    } while (progress.moreWork);
    Assert.equal(progress.pending, 0, JSON.stringify(progress));
    Assert.equal(progress.acceptedThrough, progress.sourceWatermark);
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
    if (context.fullSet.length != fixture.matches.length) {
      const actual = new Set(context.fullSet.map(item => Number(item.id)));
      const database = Cc["@mozilla.org/mailnews/database-core;1"].getService(
        Ci.nsIDatabaseCore
      ).messageDB;
      const missing = [];
      for (const header of fixture.matches.filter(
        candidate => !actual.has(candidate.messageKey)
      )) {
        missing.push({
          key: header.messageKey,
          messageId: header.messageId,
          native: database.getSearchState(header.messageKey),
          indexed: await fixture.service.getText(String(header.messageKey)),
        });
      }
      info(
        JSON.stringify({
          progress,
          missing,
          changesAfterFixture: database.getSearchChanges(
            progress.acceptedThrough,
            500
          ),
        })
      );
    }
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
    // Folder/view initialization may have changed native metadata while these
    // widgets were exercised. Keep the refinement, and capture current tokens.
    await context.loadMailSearch({ preserveFilters: true });
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
