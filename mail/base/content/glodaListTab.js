/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

ChromeUtils.defineESModuleGetters(this, {
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  GlodaConstants: "resource:///modules/gloda/GlodaConstants.sys.mjs",
  GlodaSyntheticView: "resource:///modules/gloda/GlodaSyntheticView.sys.mjs",
  findMailSearchResults: "resource:///modules/panorama/MailSearch.sys.mjs",
  openDefaultMailSearchList: "resource:///modules/panorama/MailSearch.sys.mjs",
  openDefaultMailSearchResultsList:
    "resource:///modules/panorama/MailSearch.sys.mjs",
  copyMailSearchSelection:
    "resource:///modules/panorama/MailSearchResult.sys.mjs",
});

/**
 * Opens global search results in the existing mail3PaneTab list view.
 * Replacement callers pass mailSearch text/selection or an active result set.
 */
const glodaTableListTabType = {
  name: "glodaTableList",
  perTabPanel: "vbox",
  lastTabId: 0,
  strings: Services.strings.createBundle(
    "chrome://messenger/locale/glodaFacetView.properties"
  ),
  modes: {
    glodaTableList: {
      type: "glodaSearch",
    },
  },
  openTab(aTab, aArgs) {
    aTab.panel.setAttribute("id", "glodaListTab" + this.lastTabId);
    const tabmail = document.getElementById("tabmail");

    if ("mailSearch" in aArgs) {
      const controller = new AbortController();
      aTab.mailSearchController = controller;
      const {
        text = "",
        selection = null,
        andTerms = true,
        sourceId = null,
      } = aArgs.mailSearch;
      const title =
        aArgs.title ||
        text ||
        this.strings.GetStringFromName(
          selection
            ? "glodaFacetView.tab.query.label"
            : "glodaFacetView.tab.search.label"
        );
      this.lastTabId++;
      // Native result delivery still completes through the synthetic view.
      aTab.searchPromise = (async () => {
        // Capture typed values and active members before service lookup yields.
        const copiedSelection = copyMailSearchSelection(selection);
        if (sourceId !== null && (typeof sourceId != "string" || !sourceId)) {
          throw new TypeError("Expected a native completion source");
        }
        let resultSet = aArgs.mailSearch.resultSet;
        if (!resultSet && sourceId !== null) {
          resultSet = await findMailSearchResults(text, {
            selection: copiedSelection,
            andTerms,
            signal: controller.signal,
          });
        }
        controller.signal.throwIfAborted();
        if (sourceId !== null && resultSet.sourceId != sourceId) {
          throw new DOMException(
            "Native completion source changed",
            "InvalidStateError"
          );
        }
        if (resultSet) {
          const captured = {
            sourceId: resultSet.sourceId,
            resultSetId: resultSet.resultSetId,
            items: resultSet.items.map(item => ({ ...item })),
          };
          return openDefaultMailSearchResultsList(tabmail, captured, {
            title,
            signal: controller.signal,
          });
        }
        return openDefaultMailSearchList(tabmail, text, {
          selection: copiedSelection,
          andTerms,
          title,
          signal: controller.signal,
        });
      })();
      aTab.searchPromise.then(
        () => {
          if (tabmail.tabInfo.includes(aTab)) {
            tabmail.closeTab(aTab);
          }
        },
        error => {
          if (!controller.signal.aborted) {
            console.error(error);
          }
          if (tabmail.tabInfo.includes(aTab)) {
            tabmail.closeTab(aTab);
          }
        }
      );
      return;
    }

    // Already-resolved items (e.g. from the facet view's active set button).
    if ("items" in aArgs) {
      tabmail.openTab("mail3PaneTab", {
        folderPaneVisible: false,
        syntheticView: new GlodaSyntheticView({
          collection: Gloda.explicitCollection(
            GlodaConstants.NOUN_MESSAGE,
            aArgs.items
          ),
        }),
        title:
          aArgs.title ||
          this.strings.GetStringFromName("glodaFacetView.tab.query.label"),
      });
      this.lastTabId++;
      tabmail.closeTab(aTab);
      return;
    }

    // Async query/searcher: open once the collection finishes loading.
    let collection, title;
    if ("query" in aArgs) {
      collection = aArgs.query.getCollection();
      title = this.strings.GetStringFromName("glodaFacetView.tab.query.label");
    } else if ("searcher" in aArgs) {
      collection = aArgs.searcher.getCollection();
      title =
        aArgs.searcher.searchString ||
        this.strings.GetStringFromName("glodaFacetView.tab.search.label");
    } else {
      return;
    }
    this.lastTabId++;
    collection.listener = {
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted() {
        tabmail.openTab("mail3PaneTab", {
          folderPaneVisible: false,
          syntheticView: new GlodaSyntheticView({
            collection: Gloda.explicitCollection(
              GlodaConstants.NOUN_MESSAGE,
              collection.items
            ),
          }),
          title,
        });
        tabmail.closeTab(aTab);
      },
    };
  },
  closeTab(tab) {
    tab.mailSearchController?.abort(
      new DOMException("Search tab closed", "AbortError")
    );
  },
  saveTabState() {},
  showTab() {},
  getBrowser() {
    return null;
  },
};
