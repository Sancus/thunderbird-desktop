/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Provides native physical headers to DBViewWrapper.openSynthetic.
 * Uses the existing mail list and reader. This is a search snapshot, not a
 * conversation view or a gap-free live query.
 */
export class MailSearchView {
  #service;
  #text;
  #andTerms;
  #resultSet;
  #search = null;
  customColumns = [];
  viewType = "global";

  /**
   * @param {MailSearchService} service - Native replacement search service.
   * @param {string} text - Search words/phrases.
   * @param {boolean} [andTerms=true] - Require every term.
   * @param {?MailSearchResultSet} [resultSet=null] - Export these physical members.
   */
  constructor(service, text, andTerms = true, resultSet = null) {
    this.#service = service;
    this.#text = text;
    this.#andTerms = andTerms;
    this.#resultSet = resultSet && {
      sourceId: resultSet.sourceId,
      resultSetId: resultSet.resultSetId,
      items: resultSet.items.map(item => ({ ...item })),
    };
    this.defaultSort = [
      [
        Services.prefs.getIntPref(
          "mailnews.default_sort_type",
          Ci.nsMsgViewSortType.byDate
        ),
        Services.prefs.getIntPref(
          "mailnews.default_sort_order",
          Ci.nsMsgViewSortOrder.descending
        ),
      ],
    ];
  }

  /**
   * Starts native header delivery and completes the listener exactly once.
   *
   * @param {nsIMsgSearchNotify} listener - Existing synthetic search listener.
   * @param {function(): void} [completion] - Existing view completion callback.
   * @returns {Promise<void>} Settles after delivery/completion has been observed.
   */
  search(listener, completion) {
    this.abortSearch();
    const run = { listener, completion, controller: new AbortController() };
    this.#search = run;
    try {
      listener.onNewSearch();
    } catch (error) {
      try {
        this.#finish(run, error.result || Cr.NS_ERROR_FAILURE);
      } catch (completionError) {
        throw new AggregateError(
          [error, completionError],
          "Mail search listener failed"
        );
      }
      throw error;
    }
    if (this.#search != run) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => {
        run.controller.signal.throwIfAborted();
        const stream = this.#resultSet
          ? this.#service.streamResultHeaders.bind(this.#service)
          : this.#service.streamHeaders.bind(this.#service);
        return stream(
          this.#resultSet || this.#text,
          header => {
            run.controller.signal.throwIfAborted();
            if (this.#search == run) {
              listener.onSearchHit(header, header.folder);
            }
          },
          {
            andTerms: this.#andTerms,
            signal: run.controller.signal,
          }
        );
      })
      .then(
        () => this.#finish(run, Cr.NS_OK),
        error => {
          if (this.#search != run) {
            return;
          }
          console.error(error);
          this.#finish(run, error.result || Cr.NS_ERROR_FAILURE);
        }
      )
      .catch(console.error);
  }

  /** Cancels pending delivery and completes the old listener once. */
  abortSearch() {
    const run = this.#search;
    if (run) {
      run.controller.abort(new Error("Mail search view cancelled"));
      this.#finish(run, Cr.NS_BINDING_ABORTED);
    }
  }

  /**
   * Clears the active search before invoking callbacks, including reentrant ones.
   *
   * @param {object} run - Active listener and cancellation state.
   * @param {nsresult} status - Native search completion status.
   */
  #finish(run, status) {
    if (this.#search != run) {
      return;
    }
    this.#search = null;
    try {
      run.listener.onSearchDone(status);
    } finally {
      run.completion?.();
    }
  }

  /**
   * Reads the existing global search column settings.
   *
   * @param {string} name - View setting name.
   * @returns {object|undefined} Stored setting, or the default columns.
   */
  getPersistedSetting(name) {
    try {
      return JSON.parse(
        Services.prefs.getCharPref(
          "mailnews.database.global.views.global." + name
        )
      );
    } catch {
      return this.getDefaultSetting(name);
    }
  }

  /**
   * Writes the existing global search view preference.
   *
   * @param {string} name - View setting name.
   * @param {object} value - JSON-serializable setting.
   */
  setPersistedSetting(name, value) {
    Services.prefs.setCharPref(
      "mailnews.database.global.views.global." + name,
      JSON.stringify(value)
    );
  }

  /**
   * Returns the existing search list's default visible columns.
   *
   * @param {string} name - View setting name.
   * @returns {object|undefined} Default columns, or undefined for other settings.
   */
  getDefaultSetting(name) {
    if (name != "columns") {
      return undefined;
    }
    const correspondents = Services.prefs.getBoolPref(
      "mail.threadpane.use_correspondents",
      true
    );
    return {
      threadCol: { visible: true },
      flaggedCol: { visible: true },
      subjectCol: { visible: true },
      correspondentCol: { visible: correspondents },
      senderCol: { visible: !correspondents },
      dateCol: { visible: true },
      locationCol: { visible: true },
    };
  }
}

/**
 * Opens replacement search results in the existing mail3PaneTab.
 *
 * @param {Element} tabmail - Existing tab manager.
 * @param {MailSearchService} service - Native replacement search service.
 * @param {string} text - Search words/phrases.
 * @param {object} [options] - Existing tab and query options.
 * @param {boolean} [options.andTerms=true] - Require every term.
 * @param {string} [options.title=text] - Tab title.
 * @param {boolean} [options.background=false] - Open without selecting the tab.
 * @param {?MailSearchResultSet} [options.resultSet=null] - Export active facet members.
 * @returns {object} The normal mail tab.
 */
export function openMailSearchList(
  tabmail,
  service,
  text,
  { andTerms = true, title = text, background = false, resultSet = null } = {}
) {
  service.start();
  return tabmail.openTab("mail3PaneTab", {
    folderPaneVisible: false,
    syntheticView: new MailSearchView(service, text, andTerms, resultSet),
    title:
      title ||
      Services.strings
        .createBundle("chrome://messenger/locale/glodaFacetView.properties")
        .GetStringFromName("glodaFacetView.tab.search.label"),
    background,
  });
}
