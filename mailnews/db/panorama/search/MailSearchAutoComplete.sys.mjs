/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { completeMailSearch } from "resource:///modules/panorama/MailSearch.sys.mjs";
import { copyMailSearchSelection } from "resource:///modules/panorama/MailSearchResult.sys.mjs";
import { canCompleteMailSearchPeople } from "resource:///modules/panorama/MailSearchCompletion.sys.mjs";

/**
 * @typedef {object} MailSearchAutoCompleteRow
 * @property {"fulltext"|"person"|"tag"} type - Literal native choice kind.
 * @property {boolean} fullText - Whether Enter submits the original full-text input.
 * @property {boolean} multi - Always false; no Gloda collections are exposed.
 * @property {string} typeForStyle - Existing popup richlistitem name.
 * @property {string|{value?: string, contact?: {name: string}, accessibleLabel?: string,
 *   key?: string, tag?: string}} item - Plain display fields required by that widget.
 * @property {string[]} [words] - Full-text hint words/phrases.
 * @property {MailSearchSelection} [selection] - Literal typed person/tag selection.
 * @property {string} [sourceId] - Native incarnation for typed choices.
 * @property {string} [label] - Current person/tag display label.
 */

/**
 * Keeps the retained full-text hint's phrase/comma display rules. The submitted
 * query remains the original input, including embedded quotes and punctuation.
 *
 * @param {string} text - Original search input.
 * @returns {?MailSearchAutoCompleteRow} Existing full-text row, or null below its threshold.
 */
function fullTextRow(text) {
  if (text.length < 4) {
    return null;
  }
  const words = [];
  let remaining = text.trim();
  let phrase = false;
  while (remaining) {
    let term;
    if (remaining.startsWith('"')) {
      const end = remaining.indexOf('"', 1);
      if (end == -1) {
        remaining = remaining.substring(1);
        continue;
      }
      phrase = true;
      term = remaining.substring(1, end).trim();
      remaining = remaining.substring(end + 1);
    } else {
      const end = remaining.indexOf(" ");
      term = (end < 0 ? remaining : remaining.substring(0, end)).replaceAll(
        ",",
        ""
      );
      remaining = end < 0 ? "" : remaining.substring(end + 1);
    }
    if (term) {
      words.push(term);
    }
  }
  return words.length
    ? Object.freeze({
        type: "fulltext",
        fullText: true,
        multi: false,
        item: text,
        words: Object.freeze(words),
        typeForStyle:
          "gloda-fulltext-" +
          (words.length == 1 && !phrase ? "single" : "all") +
          "-richlistitem",
      })
    : null;
}

/**
 * Maps typed values to plain display fields used by the retained popup widgets.
 * No Gloda noun, identity, query or collection is created.
 *
 * @param {MailSearchCompletion} choice - Current native completion.
 * @param {string} sourceId - Actual database incarnation.
 * @returns {MailSearchAutoCompleteRow} Immutable row with a literal native selection.
 */
function typedRow(choice, sourceId) {
  if (typeof choice.label != "string") {
    throw new TypeError("A completion label is required");
  }
  const selection = copyMailSearchSelection(choice.selection);
  if (!selection) {
    throw new TypeError("A typed completion selection is required");
  }
  if (selection.type == "person") {
    Object.freeze(selection.emails);
  }
  Object.freeze(selection);
  const person = selection.type == "person";
  const item = person
    ? {
        value: selection.emails[0],
        contact: Object.freeze({ name: choice.label }),
        accessibleLabel: choice.label + " <" + selection.emails[0] + ">",
      }
    : { key: selection.key, tag: choice.label };
  return Object.freeze({
    type: selection.type,
    sourceId,
    selection,
    fullText: false,
    multi: false,
    label: choice.label,
    item: Object.freeze(item),
    typeForStyle:
      "gloda-single-" + (person ? "identity" : "tag") + "-richlistitem",
  });
}

/**
 * Result protocol plus the retained popup's getObjectAt hook.
 *
 * @implements {nsIAutoCompleteResult}
 */
class MailSearchAutoCompleteResult {
  QueryInterface = ChromeUtils.generateQI(["nsIAutoCompleteResult"]);
  wrappedJSObject = this;
  sourceId = null;
  defaultIndex = -1;
  error = null;
  // Rejections stay in error; descriptions would add a controller row.
  errorDescription = "";
  failed = false;
  ongoing = false;
  active = true;

  /**
   * @param {string} text - Original controller search string.
   * @param {MailSearchAutoCompleteRow[]} rows - Initial rows.
   */
  constructor(text, rows) {
    this.searchString = text;
    this.rows = rows;
  }

  get searchResult() {
    if (this.failed) {
      return Ci.nsIAutoCompleteResult.RESULT_FAILURE;
    }
    return this.matchCount
      ? this.ongoing
        ? Ci.nsIAutoCompleteResult.RESULT_SUCCESS_ONGOING
        : Ci.nsIAutoCompleteResult.RESULT_SUCCESS
      : this.ongoing
        ? Ci.nsIAutoCompleteResult.RESULT_NOMATCH_ONGOING
        : Ci.nsIAutoCompleteResult.RESULT_NOMATCH;
  }
  get matchCount() {
    return this.rows.length;
  }
  getObjectAt(index) {
    return Number.isInteger(index) && index >= 0
      ? (this.rows[index] ?? null)
      : null;
  }
  getValueAt(index) {
    const row = this.rows[index];
    return row.fullText ? row.item : (row.item.value ?? row.item.tag);
  }
  getLabelAt(index) {
    const row = this.rows[index];
    return row.fullText ? row.item : row.label;
  }
  getCommentAt(index) {
    const row = this.rows[index];
    return row.type == "person" ? row.item.value : "";
  }
  getStyleAt(index) {
    return this.rows[index].typeForStyle;
  }
  getImageAt() {
    return "";
  }
  getFinalCompleteValueAt(index) {
    return this.getValueAt(index);
  }
  isRemovableAt() {
    return false;
  }
  removeValueAt() {}
}

/**
 * Native nsIAutoCompleteSearch for the retained global-search component contract.
 * stopSearch cancels delivery but keeps displayed rows: Gecko calls it before
 * EnterMatch, and the existing input then reads curResult.getObjectAt().
 *
 * @implements {nsIAutoCompleteSearch}
 */
export class MailSearchAutoComplete {
  QueryInterface = ChromeUtils.generateQI(["nsIAutoCompleteSearch"]);
  wrappedJSObject = this;
  isNativeMailSearch = true;
  curResult = null;
  /** @type {?{result: MailSearchAutoCompleteResult, controller: AbortController}} */
  #run = null;
  /** @type {typeof completeMailSearch} */
  #complete;

  /**
   * @param {typeof completeMailSearch} [complete=completeMailSearch] -
   *   Existing native completion call; replaceable for deterministic async tests.
   */
  constructor(complete = completeMailSearch) {
    this.#complete = complete;
  }

  /**
   * Publishes an empty pending result then one terminal native result. Full-text
   * and typed rows appear only on success. Errors clear all rows and retain the
   * original error; no legacy fallback is invoked.
   *
   * @param {string} text - Original input.
   * @param {string} param - Only the existing global mode is supported.
   * @param {?nsIAutoCompleteResult} previous - Not reused across native/policy changes.
   * @param {nsIAutoCompleteObserver} listener - Receives this search and result.
   */
  startSearch(text, param, previous, listener) {
    this.stopSearch();
    const enabled =
      param == "global" &&
      Services.prefs.getBoolPref(
        "mailnews.database.global.indexer.enabled",
        false
      );
    const full = enabled && fullTextRow(text);
    const result = new MailSearchAutoCompleteResult(text, []);
    const run = { result, controller: new AbortController() };
    this.#run = run;
    this.curResult = result;
    result.ongoing =
      enabled &&
      !!text.trim() &&
      (text.length >= 2 || canCompleteMailSearchPeople(text));
    try {
      listener.onSearchResult(this, result);
    } catch (error) {
      if (this.#run === run) {
        this.stopSearch();
      }
      throw error;
    }
    if (!result.ongoing || this.#run !== run) {
      return;
    }
    Promise.resolve()
      .then(() => {
        run.controller.signal.throwIfAborted();
        return this.#complete(text, { signal: run.controller.signal });
      })
      .then(data => {
        if (this.#run !== run || run.controller.signal.aborted) {
          return;
        }
        if (typeof data.sourceId != "string" || !data.sourceId) {
          throw new TypeError("Completion source identity is required");
        }
        return {
          sourceId: data.sourceId,
          rows: data.items.map(choice => typedRow(choice, data.sourceId)),
        };
      })
      .then(
        data => {
          if (this.#run !== run || run.controller.signal.aborted) {
            return;
          }
          result.sourceId = data.sourceId;
          result.rows = Services.prefs.getBoolPref(
            "mailnews.database.global.indexer.enabled",
            false
          )
            ? [...(full ? [full] : []), ...data.rows]
            : [];
          result.ongoing = false;
          listener.onSearchResult(this, result);
        },
        error => this.#fail(run, listener, error)
      )
      .catch(error => {
        // A listener exception must not cause a second completion callback.
        console.error(error);
      });
  }

  /**
   * Preserves a backend failure distinctly from a successful empty result.
   *
   * @param {{result: MailSearchAutoCompleteResult, controller: AbortController}} run -
   *   Current query owner.
   * @param {nsIAutoCompleteObserver} listener - Current controller callback.
   * @param {unknown} error - Original rejection, including falsy reasons.
   */
  #fail(run, listener, error) {
    if (this.#run !== run || run.controller.signal.aborted) {
      return;
    }
    run.result.rows = [];
    run.result.failed = true;
    run.result.ongoing = false;
    run.result.error = error;
    listener.onSearchResult(this, run.result);
  }

  /** Stops old delivery without destroying the row selected by EnterMatch. */
  stopSearch() {
    if (this.#run) {
      this.#run.result.active = false;
      this.#run.controller.abort(
        new DOMException("Autocomplete stopped", "AbortError")
      );
      this.#run = null;
    }
  }
}
