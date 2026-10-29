/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/* global MozXULElement */

"use strict";

// The autocomplete CE is defined lazily. Create one now to get
// autocomplete-input defined, allowing us to inherit from it.
if (!customElements.get("autocomplete-input")) {
  delete document.createXULElement("input", { is: "autocomplete-input" });
}

customElements.whenDefined("autocomplete-input").then(() => {
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    copyMailSearchSelection:
      "resource:///modules/panorama/MailSearchResult.sys.mjs",
    GlodaIMSearcher: "resource:///modules/GlodaIMSearcher.sys.mjs",
    Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
    GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
    GlodaConstants: "resource:///modules/gloda/GlodaConstants.sys.mjs",
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
   * The MozGlodaAutocompleteInput widget is used to display the autocomplete search bar.
   *
   * @augments {AutocompleteInput}
   */
  class MozGlodaAutocompleteInput extends customElements.get(
    "autocomplete-input"
  ) {
    constructor() {
      super();

      this.addEventListener(
        "drop",
        event => {
          this.searchInputDNDObserver.onDrop(event);
        },
        true
      );

      this.addEventListener("keypress", event => {
        if (event.keyCode == KeyEvent.DOM_VK_RETURN) {
          // Trigger the click event if a popup result is currently selected.
          if (this.popup.richlistbox.selectedIndex != -1) {
            this.popup.onPopupClick(event);
          } else {
            this.doSearch();
          }
          event.preventDefault();
          event.stopPropagation();
        }

        if (event.keyCode == KeyEvent.DOM_VK_ESCAPE) {
          this.clearSearch();
          event.preventDefault();
          event.stopPropagation();
        }
      });

      window.addEventListener("unload", () => {
        if (this.hasConnected) {
          Services.obs.removeObserver(
            this.textObserver,
            "autocomplete-did-enter-text"
          );
        }
      });
    }

    connectedCallback() {
      if (this.hasConnected) {
        return;
      }

      this.hasConnected = true;
      super.connectedCallback();

      this.setAttribute("is", "gloda-autocomplete-input");

      // @implements {nsIObserver}
      this.searchInputDNDObserver = {
        onDrop: event => {
          if (event.dataTransfer.types.includes("text/x-moz-address")) {
            this.focus();
            this.value = event.dataTransfer.getData("text/plain");
            // XXX for some reason the input field is _cleared_ even though
            // the search works.
            this.doSearch();
          }
          event.stopPropagation();
        },
      };

      // @implements {nsIObserver}
      this.textObserver = {
        observe: (subject, topic) => {
          try {
            // Some autocomplete controllers throw NS_ERROR_NOT_IMPLEMENTED.
            subject.popupElement;
          } catch (ex) {
            return;
          }
          if (
            topic == "autocomplete-did-enter-text" &&
            document.activeElement == this
          ) {
            const selectedIndex = this.popup.selectedIndex;
            const curResult = lazy.glodaCompleter.curResult;
            if (!curResult) {
              // autocomplete didn't even finish.
              return;
            }
            const row = curResult.getObjectAt(selectedIndex);
            if (row == null) {
              return;
            }
            if (lazy.glodaCompleter.isNativeMailSearch) {
              if (
                this.controller.input?.wrappedJSObject !=
                  this.nsIAutocompleteInput ||
                (this.popup.input?.wrappedJSObject ?? this.popup.input) !=
                  this.nsIAutocompleteInput
              ) {
                return;
              }
              const selection = row.fullText
                ? null
                : lazy.copyMailSearchSelection(row.selection);
              const sourceId = row.fullText ? null : row.sourceId;
              if (
                !row.fullText &&
                (!selection ||
                  typeof row.label != "string" ||
                  typeof sourceId != "string" ||
                  !sourceId)
              ) {
                throw new TypeError(
                  "Expected a source-bound native completion"
                );
              }
              const request = {
                text: row.fullText ? row.item : "",
                selection,
                sourceId,
                title: row.fullText ? row.item : row.label,
              };
              const tabmail = document.getElementById("tabmail");
              const owner = tabmail.currentTabInfo;
              const generation = ++this._nativeSearchGeneration;
              // EnterMatch still owns this input until the observer returns.
              setTimeout(() => {
                if (
                  generation == this._nativeSearchGeneration &&
                  lazy.glodaCompleter.curResult == curResult &&
                  this.isConnected &&
                  tabmail.currentTabInfo == owner
                ) {
                  this._openNativeMailSearch(request, owner);
                }
              }, 0);
              return;
            }
            if (row.fullText) {
              // The autocomplete-did-enter-text notification is synchronously
              // generated by nsAutoCompleteController which will attempt to
              // call ClosePopup after we return and then tell the searchbox
              // about the text entered. Since doSearch may close the current
              // tab (and thus destroy the XUL document that owns the popup and
              // the input field), the search box may no longer have its
              // binding attached when we return and telling it about the
              // entered text could fail.
              // To avoid this, we defer the doSearch call to the next turn of
              // the event loop by using setTimeout.
              setTimeout(this.doSearch.bind(this), 0);
            } else if (row.nounDef) {
              const showAsList = Services.prefs.getBoolPref(
                "gloda.show_as_list_by_default",
                false
              );
              let query = lazy.Gloda.newQuery(lazy.GlodaConstants.NOUN_MESSAGE);
              if (row.nounDef.name == "tag") {
                query = query.tags(row.item);
              } else if (row.nounDef.name == "identity") {
                query = query.involves(row.item);
              }
              query.orderBy("-date");
              const args = { query };
              document
                .getElementById("tabmail")
                .openTab(showAsList ? "glodaTableList" : "glodaFacet", args);
            }
          }
        },
      };

      const keyLabel =
        AppConstants.platform == "macosx" ? "keyLabelMac" : "keyLabelNonMac";
      const placeholder = this.getAttribute("emptytextbase").replace(
        "#1",
        this.getAttribute(keyLabel)
      );

      this.setAttribute("placeholder", placeholder);

      Services.obs.addObserver(
        this.textObserver,
        "autocomplete-did-enter-text"
      );

      // make sure we set our emptytext here from the get-go
      if (this.hasAttribute("placeholder")) {
        this.placeholder = this.getAttribute("placeholder");
      }
    }

    set state(val) {
      this.value = val.string;
    }

    get state() {
      return { string: this.value };
    }

    _nativeSearchGeneration = 0;

    /**
     * Opens a captured native request without routing plain display data as nouns.
     *
     * @param {object} request - Copied text, typed selection, source and title.
     * @param {object} owner - Existing tab that owned the input at selection.
     */
    _openNativeMailSearch(request, owner) {
      const tabmail = document.getElementById("tabmail");
      if (tabmail.currentTabInfo != owner) {
        return;
      }
      lazy.glodaCompleter.stopSearch();
      this.value = "";
      if (!request.selection && owner.mode.name == "glodaFacet") {
        tabmail.closeTab(owner);
      }
      tabmail.openTab(
        Services.prefs.getBoolPref("gloda.show_as_list_by_default", false)
          ? "glodaTableList"
          : "glodaFacet",
        { mailSearch: request, title: request.title }
      );
    }

    doSearch() {
      if (this.value && lazy.glodaCompleter.isNativeMailSearch) {
        this._nativeSearchGeneration++;
        this._openNativeMailSearch(
          {
            text: this.value,
            selection: null,
            sourceId: null,
            title: this.value,
          },
          document.getElementById("tabmail").currentTabInfo
        );
        return;
      }
      if (this.value) {
        const tabmail = document.getElementById("tabmail");
        // If the current tab is a gloda search tab, reset the value
        // to the initial search value. Otherwise, clear it. This
        // is the value that is going to be saved with the current
        // tab when we switch back to it next.
        const searchString = this.value;

        if (tabmail.currentTabInfo.mode.name == "glodaFacet") {
          // We'd rather reuse the existing tab (and somehow do something
          // smart with any preexisting facet choices, but that's a
          // bit hard right now, so doing the cheap thing and closing
          // this tab and starting over.
          tabmail.closeTab();
        }
        this.value = ""; // clear our value, to avoid persistence
        const showAsList = Services.prefs.getBoolPref(
          "gloda.show_as_list_by_default",
          false
        );
        const args = {
          searcher: new lazy.GlodaMsgSearcher(null, searchString),
        };
        if (Services.prefs.getBoolPref("mail.chat.enabled")) {
          args.IMSearcher = new lazy.GlodaIMSearcher(null, searchString);
        }
        tabmail.openTab(showAsList ? "glodaTableList" : "glodaFacet", args);
      }
    }

    clearSearch() {
      this._nativeSearchGeneration++;
      if (
        lazy.glodaCompleter.isNativeMailSearch &&
        this.controller.input?.wrappedJSObject == this.nsIAutocompleteInput
      ) {
        this.controller.stopSearch();
      }
      this.value = "";
    }

    disconnectedCallback() {
      this._nativeSearchGeneration++;
      if (
        lazy.glodaCompleter.isNativeMailSearch &&
        this.controller.input?.wrappedJSObject == this.nsIAutocompleteInput
      ) {
        this.controller.stopSearch();
      }
      Services.obs.removeObserver(
        this.textObserver,
        "autocomplete-did-enter-text"
      );
      this.hasConnected = false;
    }
  }

  MozXULElement.implementCustomInterface(MozGlodaAutocompleteInput, [
    Ci.nsIObserver,
  ]);
  customElements.define("gloda-autocomplete-input", MozGlodaAutocompleteInput, {
    extends: "input",
  });
});
