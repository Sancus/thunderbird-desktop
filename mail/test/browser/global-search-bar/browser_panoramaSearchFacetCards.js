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
  async function test_openFacetCardChangesRefreshCurrentPhysicalCopies() {
    const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
      Ci.nsIAbCard
    );
    card.primaryEmail = "livefacetcard@example.invalid";
    card.displayName = "Open Facet Card A";
    let currentCard = book.addCard(card);
    const generator = fixture.generator;
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

      const selected = context.activeSet.find(
        item => item.id == String(headers[1].messageKey)
      );
      const conversation = await context.openMailSearchConversation(
        selected,
        true
      );
      Assert.ok(conversation);
      const selectedView = await readNativeList(conversation);
      // Equal Message-ID without a References edge must not substitute its peer.
      Assert.deepEqual(selectedView.identities, [physicalIdentity(headers[1])]);
      await TestUtils.waitForCondition(
        () => selectedView.pane.gDBView.numSelected == 1
      );
      Assert.equal(
        physicalIdentity(selectedView.pane.gDBView.hdrForFirstSelectedMessage),
        physicalIdentity(headers[1]),
        "The refreshed current token opens and selects the clicked physical copy"
      );
      tabmail.closeTab(conversation);

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
      const replacement = Cc[
        "@mozilla.org/addressbook/cardproperty;1"
      ].createInstance(Ci.nsIAbCard);
      replacement.primaryEmail = card.primaryEmail;
      replacement.displayName = "Open Facet Replacement";
      currentCard = book.addCard(replacement);
      await TestUtils.waitForCondition(
        () => collected,
        "A later real card notification starts one refresh"
      );
      const pending = tab.searchPromise;
      tabmail.closeTab(tab);
      tab = null;
      const remaining = tabmail.tabInfo.length;
      Assert.equal(
        await pending,
        null,
        "Tab closure settles the parent promise before the held query returns"
      );
      release();
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
