/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

import { SearchBar } from "chrome://messenger/content/search-bar.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  copyMailSearchSelection:
    "resource:///modules/panorama/MailSearchResult.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  GlodaConstants: "resource:///modules/gloda/GlodaConstants.sys.mjs",
  GlodaIMSearcher: "resource:///modules/GlodaIMSearcher.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "glodaCompleter",
  () =>
    Cc["@mozilla.org/autocomplete/search;1?name=gloda"].getService(
      Ci.nsIAutoCompleteSearch
    ).wrappedJSObject
);

/**
 * Unified toolbar global search bar.
 */
class GlobalSearchBar extends SearchBar {
  // Fields required for the auto complete popup to work.

  get popup() {
    return document.getElementById("PopupGlodaAutocomplete");
  }

  controller = {
    matchCount: 0,
    searchString: "",
    stopSearch: () => this.#stopCompletion(),
    handleEnter: isAutocomplete => {
      if (!isAutocomplete) {
        return;
      }
      this.#handleSearch({ detail: this.controller.searchString });
      this.reset();
    },
  };

  _focus() {
    this.focus();
  }

  #completionResult = null;
  #refreshSelection = null;
  #observingNames = false;

  #nameObserver = {
    observe: (subject, topic, sourceId) => {
      const provider = lazy.glodaCompleter;
      const result = this.#completionResult;
      if (
        !this.isConnected ||
        !this.popup.mPopupOpen ||
        !result?.active ||
        provider.curResult != result ||
        (result.sourceId && result.sourceId != sourceId)
      ) {
        return;
      }
      const row = result.getObjectAt(this.popup.selectedIndex);
      this.#refreshSelection = row
        ? {
            selection: JSON.stringify(row.selection ?? null),
            fullText: !!row.fullText,
            sourceId: row.sourceId ?? null,
          }
        : null;
      provider.startSearch(
        this.controller.searchString,
        "global",
        null,
        this.#searchResultListener
      );
    },
  };

  /** Observe card delivery only while this native input is connected. */
  #observeNames() {
    if (this.#observingNames || !("nsIDatabaseCore" in Ci)) {
      return;
    }
    // Checking the registered backend must not construct the legacy completer
    // before the user starts a search.
    lazy.MailServices.accounts;
    const backend = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    if (
      !(backend instanceof Ci.nsIDatabaseCore) ||
      !lazy.glodaCompleter.isNativeMailSearch
    ) {
      return;
    }
    this.#observingNames = true;
    Services.obs.addObserver(
      this.#nameObserver,
      "panorama-mail-search-names-changed"
    );
    this.popup.addEventListener("popuphidden", this);
    window.addEventListener("unload", this, { once: true });
  }

  disconnectedCallback() {
    if (this.#observingNames) {
      this.#stopCompletion();
      this.#observingNames = false;
      Services.obs.removeObserver(
        this.#nameObserver,
        "panorama-mail-search-names-changed"
      );
      this.popup.removeEventListener("popuphidden", this);
      window.removeEventListener("unload", this);
    }
  }

  /** Stops delivery only for the result owned by this input. */
  #stopCompletion() {
    this.#refreshSelection = null;
    if (!this.#completionResult) {
      lazy.MailServices.accounts;
      const backend = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
        Ci.nsIMsgDBService
      );
      if (!("nsIDatabaseCore" in Ci) || !(backend instanceof Ci.nsIDatabaseCore)) {
        return;
      }
    }
    const provider = lazy.glodaCompleter;
    if (provider.curResult && provider.curResult == this.#completionResult) {
      provider.stopSearch();
    }
  }

  #searchResultListener = {
    onSearchResult: (result, search) => {
      const provider = lazy.glodaCompleter;
      if (
        (result.wrappedJSObject ?? result) != provider ||
        (search.wrappedJSObject ?? search) != provider.curResult ||
        search.searchString != this.controller.searchString
      ) {
        return;
      }
      this.#completionResult = search.wrappedJSObject ?? search;
      this.controller.matchCount = search.matchCount;
      if (provider.isNativeMailSearch && search.ongoing) {
        this.popup.selectedIndex = -1;
        // Hiding this shared popup calls stopSearch. Clear the old rows without
        // cancelling the pending query that will replace them.
        this.popup.invalidate();
        return;
      }
      let selectedIndex = null;
      if (this.#refreshSelection) {
        const selected = this.#refreshSelection;
        this.#refreshSelection = null;
        selectedIndex = search.rows.findIndex(
          row =>
            !!row.fullText == selected.fullText &&
            (row.sourceId ?? null) == selected.sourceId &&
            JSON.stringify(row.selection ?? null) == selected.selection
        );
      }
      if (this.controller.matchCount < 1) {
        this.popup.closePopup();
        if (provider.isNativeMailSearch) {
          this.popup.selectedIndex = -1;
        }
        return;
      }
      if (!this.popup.mPopupOpen) {
        this.popup.openAutocompletePopup(
          this,
          this.shadowRoot.querySelector("input")
        );
      } else {
        this.popup.invalidate();
      }
      // The richlistbox cannot select an index until its new rows exist.
      if (
        selectedIndex !== null &&
        this.#completionResult == (search.wrappedJSObject ?? search) &&
        provider.curResult == this.#completionResult
      ) {
        this.popup.selectedIndex = selectedIndex;
      }
    },
  };

  // Normal custom element stuff

  connectedCallback() {
    if (this.shadowRoot) {
      this.#observeNames();
      return;
    }
    if (
      !Services.prefs.getBoolPref(
        "mailnews.database.global.indexer.enabled",
        true
      )
    ) {
      return;
    }
    // Need to call this after the shadow root test, since this will always set
    // up a shadow root.
    super.connectedCallback();
    this.addEventListener("search", this);
    this.addEventListener("autocomplete", this);
    this.addEventListener("focus", this);
    this.addEventListener("blur", this);
    this.addEventListener("drop", this, { capture: true });
    this.#observeNames();
  }

  #popupWasOpenAtDown = false;

  handleEvent(event) {
    switch (event.type) {
      case "search":
        this.#handleSearch(event);
        break;
      case "autocomplete":
        this.#handleAutocomplete(event);
        break;
      case "keydown":
        this.#handleKeydown(event);
        this.#popupWasOpenAtDown = this.popup.mPopupOpen;
        if (
          !lazy.glodaCompleter.isNativeMailSearch &&
          !event.defaultPrevented
        ) {
          super.handleEvent(event);
        }
        break;
      case "focus":
        this.#handleFocus(event);
        break;
      case "drop":
        this.#handleDrop(event);
        break;
      case "keyup":
        if (!this.#popupWasOpenAtDown || event.key !== "Escape") {
          super.handleEvent(event);
        }
        break;
      case "unload":
        this.disconnectedCallback();
        break;
      case "popuphidden":
        this.#stopCompletion();
        break;
      case "blur":
        this.#stopCompletion();
        if (this.popup.mPopupOpen) {
          this.popup.closePopup();
        }
        break;
      default:
        super.handleEvent(event);
    }
  }

  #handleSearch = event => {
    const tabmail = document.getElementById("tabmail");
    const provider = lazy.glodaCompleter;
    if (provider.isNativeMailSearch) {
      const selectedIndex = this.popup.selectedIndex;
      const result = provider.curResult;
      const row = result?.getObjectAt(selectedIndex);
      if (
        selectedIndex >= 0 &&
        (!row ||
          result != this.#completionResult ||
          result.searchString != this.controller.searchString)
      ) {
        return;
      }
      const selection =
        row && !row.fullText
          ? lazy.copyMailSearchSelection(row.selection)
          : null;
      const sourceId = row && !row.fullText ? row.sourceId : null;
      if (
        row &&
        !row.fullText &&
        (!selection ||
          typeof row.label != "string" ||
          typeof sourceId != "string" ||
          !sourceId)
      ) {
        throw new TypeError("Expected a source-bound native completion");
      }
      let text = event.detail;
      if (selection) {
        text = "";
      } else if (row?.fullText) {
        text = row.item;
      }
      const title = selection ? row.label : text;
      // Copy typed values before stopSearch/popup/reset can change the selection.
      const request = { text, selection, sourceId };
      this.#stopCompletion();
      this.popup.closePopup();
      this.controller.matchCount = 0;
      this.controller.searchString = "";
      tabmail.openTab(
        Services.prefs.getBoolPref("gloda.show_as_list_by_default", false)
          ? "glodaTableList"
          : "glodaFacet",
        { mailSearch: request, title }
      );
      return;
    }
    let args;
    const showAsList = Services.prefs.getBoolPref(
      "gloda.show_as_list_by_default",
      false
    );
    // Build the query from the autocomplete result.
    const selectedIndex = this.popup.selectedIndex;
    if (selectedIndex > -1) {
      const curResult = lazy.glodaCompleter.curResult;
      if (curResult) {
        const row = curResult.getObjectAt(selectedIndex);
        if (row && !row.fullText && row.nounDef) {
          let query = lazy.Gloda.newQuery(lazy.GlodaConstants.NOUN_MESSAGE);
          switch (row.nounDef.name) {
            case "tag":
              query = query.tags(row.item);
              break;
            case "identity":
              query = query.involves(row.item);
              break;
          }
          query.orderBy("-date");
          args = { query };
        }
      }
    }
    // Or just do a normal full text search.
    if (!args) {
      const searchString = event.detail;
      args = { searcher: new lazy.GlodaMsgSearcher(null, searchString) };
      if (Services.prefs.getBoolPref("mail.chat.enabled")) {
        args.IMSearcher = new lazy.GlodaIMSearcher(null, searchString);
      }
    }
    tabmail.openTab(showAsList ? "glodaTableList" : "glodaFacet", args);
    this.popup.closePopup();
    this.controller.matchCount = 0;
    this.controller.searchString = "";
  };

  #handleAutocomplete = event => {
    this.#refreshSelection = null;
    this.controller.searchString = event.detail;
    if (!event.detail) {
      this.#stopCompletion();
      this.#completionResult = null;
      this.popup.closePopup();
      this.controller.matchCount = 0;
      this.popup.selectedIndex = -1;
      return;
    }
    lazy.glodaCompleter.startSearch(
      this.controller.searchString,
      "global",
      null,
      this.#searchResultListener
    );
  };

  #handleKeydown = event => {
    if (event.ctrlKey) {
      return;
    }
    if (event.key == "ArrowDown" || event.key == "ArrowUp") {
      // A choice made during refresh supersedes its earlier saved selection.
      this.#refreshSelection = null;
    }
    if (event.key == "ArrowDown") {
      if (this.popup.selectedIndex < this.controller.matchCount - 1) {
        ++this.popup.selectedIndex;
        event.preventDefault();
        return;
      }
      this.popup.selectedIndex = -1;
      event.preventDefault();
      return;
    }
    if (event.key == "ArrowUp") {
      if (this.popup.selectedIndex > -1) {
        --this.popup.selectedIndex;
        event.preventDefault();
        return;
      }
      this.popup.selectedIndex = this.controller.matchCount - 1;
      event.preventDefault();
    }
  };

  #handleFocus = () => {
    if (this.controller.searchString && this.controller.matchCount >= 1) {
      this.popup.openAutocompletePopup(
        this,
        this.shadowRoot.querySelector("input")
      );
    }
  };

  #handleDrop = event => {
    if (event.dataTransfer.types.includes("text/x-moz-address")) {
      const searchTerm = event.dataTransfer.getData("text/plain");
      this.#handleSearch({ detail: searchTerm });
    }
    event.stopPropagation();
    event.preventDefault();
  };
}
customElements.define("global-search-bar", GlobalSearchBar);
