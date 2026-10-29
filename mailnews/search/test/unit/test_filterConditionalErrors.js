/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const CONDITIONAL_TERM = "local-storage-tests@example.invalid#conditional";
let conditionalHeader;
const conditionalCalls = [];
let captureFilter;
let capturedScope;

add_setup(function setupConditionalFilterErrors() {
  const names = [
    "mail.serverDefaultStoreContractID",
    "mail.server.default.storeContractID",
  ];
  const prefs = names.map(name => ({
    name,
    present: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getCharPref(name, ""),
  }));
  registerCleanupFunction(() => {
    try {
      conditionalHeader = null;
      capturedScope = null;
      captureFilter = null;
      localAccountUtils.clearAll();
    } finally {
      for (const { name, present, value } of prefs) {
        if (present) {
          Services.prefs.setCharPref(name, value);
        } else {
          Services.prefs.clearUserPref(name);
        }
      }
    }
  });
  for (const name of names) {
    Services.prefs.setCharPref(name, "@mozilla.org/msgstore/berkeleystore;1");
  }
  localAccountUtils.loadLocalMailAccount();
  const inbox = localAccountUtils.inboxFolder;
  Assert.equal(inbox.msgStore.storeType, "mbox");
  Assert.equal(inbox.server.msgStore.storeType, "mbox");
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const native =
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore;
  Assert.equal(
    native,
    Services.prefs.getBoolPref("mail.panorama.enabled", false)
  );
  conditionalHeader = inbox
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(
      "From: sender@example.invalid\r\n" +
        "To: recipient@example.invalid\r\n" +
        "Subject: needle\r\n" +
        "Message-ID: <conditional@example.invalid>\r\n\r\n" +
        "body line\r\n"
    );
  MailServices.filters.addCustomTerm({
    id: CONDITIONAL_TERM,
    name: "Conditional error test",
    needsBody: false,
    getEnabled: () => true,
    getAvailable: () => true,
    getAvailableOperators: () => [Ci.nsMsgSearchOp.Is],
    match(_header, value) {
      conditionalCalls.push(value);
      if (captureFilter) {
        capturedScope = captureFilter.scope;
      }
      if (value == "error-one") {
        throw Components.Exception(
          "first term failed",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      }
      if (value == "error-two") {
        throw Components.Exception(
          "second term failed",
          Cr.NS_ERROR_FILE_CORRUPTED
        );
      }
      return value == "true";
    },
  });
});

/**
 * Build a real filter expression from custom terms.
 *
 * @param {{value: string, and?: boolean, begin?: boolean, end?: boolean}[]} terms
 *   Values, Boolean joins, and grouping boundaries.
 * @param {nsIMsgFilterList} [list] - Owning temporary filter list.
 * @param {string} [name="expression"] - Filter name.
 * @returns {nsIMsgFilter} Enabled InboxRule filter.
 */
function conditionalFilter(terms, list, name = "expression") {
  list ??= MailServices.filters.getTempFilterList(
    localAccountUtils.inboxFolder
  );
  const filter = list.createFilter(name);
  for (const { value, and = true, begin = false, end = false } of terms) {
    const term = filter.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.Custom;
    term.customId = CONDITIONAL_TERM;
    term.op = Ci.nsMsgSearchOp.Is;
    term.booleanAnd = and;
    term.beginsGrouping = begin;
    term.endsGrouping = end;
    const searchValue = term.value;
    searchValue.attrib = Ci.nsMsgSearchAttrib.Custom;
    searchValue.str = value;
    term.value = searchValue;
    filter.appendTerm(term);
  }
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.InboxRule;
  return filter;
}

/**
 * Evaluate through MatchHdr and check only the terms actually reached.
 *
 * @param {{value: string, and?: boolean, begin?: boolean, end?: boolean}[]} terms
 *   Actual expression terms.
 * @param {boolean|number} expected - Match result or failing nsresult.
 * @param {string[]} calls - Expected evaluation order.
 */
function checkConditionalExpression(terms, expected, calls) {
  const filter = conditionalFilter(terms);
  const inbox = localAccountUtils.inboxFolder;
  conditionalCalls.length = 0;
  const match = () =>
    filter.MatchHdr(conditionalHeader, inbox, inbox.msgDatabase, "");
  if (typeof expected == "boolean") {
    Assert.equal(match(), expected);
  } else {
    Assert.throws(match, error => error.result == expected);
  }
  Assert.deepEqual(conditionalCalls, calls);
}

add_task(function test_conditionalMatch() {
  checkConditionalExpression([{ value: "true" }], true, ["true"]);
});

add_task(function test_conditionalNonMatch() {
  checkConditionalExpression([{ value: "false" }], false, ["false"]);
});

add_task(function test_conditionalFirstError() {
  checkConditionalExpression(
    [{ value: "error-one" }, { value: "true", and: false }],
    Cr.NS_ERROR_FILE_ACCESS_DENIED,
    ["error-one"]
  );
});

add_task(function test_conditionalRightError() {
  checkConditionalExpression(
    [{ value: "true" }, { value: "error-two" }],
    Cr.NS_ERROR_FILE_CORRUPTED,
    ["true", "error-two"]
  );
});

add_task(function test_conditionalAndSkipsError() {
  checkConditionalExpression(
    [{ value: "false" }, { value: "error-one" }],
    false,
    ["false"]
  );
});

add_task(function test_conditionalOrSkipsError() {
  checkConditionalExpression(
    [{ value: "true" }, { value: "error-one", and: false }],
    true,
    ["true"]
  );
});

add_task(function test_conditionalGroupedOrThenAnd() {
  checkConditionalExpression(
    [
      { value: "true", begin: true },
      { value: "error-one", and: false, end: true },
      { value: "false" },
    ],
    false,
    ["true", "false"]
  );
});

add_task(function test_conditionalGroupedAndThenOr() {
  checkConditionalExpression(
    [
      { value: "false", begin: true },
      { value: "error-one", end: true },
      { value: "true", and: false },
    ],
    true,
    ["false", "true"]
  );
});

add_task(function test_conditionalGroupedError() {
  checkConditionalExpression(
    [
      { value: "true" },
      { value: "false", begin: true },
      { value: "error-two", and: false, end: true },
    ],
    Cr.NS_ERROR_FILE_CORRUPTED,
    ["true", "false", "error-two"]
  );
});

add_task(function test_conditionalFilterListScopeAndBackendPolicy() {
  const inbox = localAccountUtils.inboxFolder;
  const list = MailServices.filters.getTempFilterList(inbox);
  const hits = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterHitNotify"]),
    applyFilterHit(filter) {
      hits.push(filter.filterName);
      return true;
    },
  };
  const apply = () =>
    list.applyFiltersToHdr(
      Ci.nsMsgFilterType.InboxRule,
      conditionalHeader,
      inbox,
      inbox.msgDatabase,
      "",
      listener,
      null
    );
  const originalScope = nativeConditionalScope();
  const first = conditionalFilter([{ value: "error-one" }], list, "first");
  const later = conditionalFilter([{ value: "true" }], list, "later");
  first.scope = originalScope;
  list.insertFilterAt(0, first);
  list.insertFilterAt(1, later);
  hits.length = 0;
  conditionalCalls.length = 0;
  if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    Assert.throws(
      apply,
      error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
    );
    Assert.deepEqual(hits, []);
    Assert.deepEqual(conditionalCalls, ["error-one"]);
  } else {
    apply();
    Assert.deepEqual(hits, ["later"], "Legacy automatic filtering continues");
    Assert.deepEqual(conditionalCalls, ["error-one", "true"]);
  }
  Assert.equal(
    first.scope,
    originalScope,
    "Original scope survives evaluation error"
  );
  Assert.equal(later.scope, null);
});

/**
 * Capture a genuine scope while the native filter list installs it.
 *
 * @returns {nsIMsgSearchScopeTerm} Native offline-mail scope.
 */
function nativeConditionalScope() {
  const inbox = localAccountUtils.inboxFolder;
  const list = MailServices.filters.getTempFilterList(inbox);
  const filter = conditionalFilter([{ value: "true" }], list, "scope capture");
  list.insertFilterAt(0, filter);
  captureFilter = filter;
  capturedScope = null;
  try {
    list.applyFiltersToHdr(
      Ci.nsMsgFilterType.InboxRule,
      conditionalHeader,
      inbox,
      inbox.msgDatabase,
      "",
      { applyFilterHit: () => true },
      null
    );
  } finally {
    captureFilter = null;
    list.removeFilter(filter);
  }
  Assert.ok(capturedScope);
  Assert.equal(filter.scope, null);
  return capturedScope;
}

/**
 * Restore a prior real scope after a successful conditional evaluation.
 *
 * @param {boolean} matched - Term result.
 */
function checkConditionalScope(matched) {
  const inbox = localAccountUtils.inboxFolder;
  const list = MailServices.filters.getTempFilterList(inbox);
  const filter = conditionalFilter(
    [{ value: matched ? "true" : "false" }],
    list
  );
  const originalScope = nativeConditionalScope();
  filter.scope = originalScope;
  list.insertFilterAt(0, filter);
  const hits = [];
  list.applyFiltersToHdr(
    Ci.nsMsgFilterType.InboxRule,
    conditionalHeader,
    inbox,
    inbox.msgDatabase,
    "",
    {
      applyFilterHit: rule => {
        hits.push(rule.filterName);
        return true;
      },
    },
    null
  );
  Assert.deepEqual(hits, matched ? ["expression"] : []);
  Assert.equal(filter.scope, originalScope);
}

add_task(function test_conditionalMatchRestoresScope() {
  checkConditionalScope(true);
});
add_task(function test_conditionalNonMatchRestoresScope() {
  checkConditionalScope(false);
});

/**
 * Match a standard Subject predicate through the existing matcher.
 *
 * @param {string} value - Subject substring.
 * @returns {boolean} MatchHdr result.
 */
function matchConditionalSubject(value) {
  const inbox = localAccountUtils.inboxFolder;
  const filter = conditionalFilter([]);
  const term = filter.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Subject;
  term.op = Ci.nsMsgSearchOp.Contains;
  const searchValue = term.value;
  searchValue.attrib = Ci.nsMsgSearchAttrib.Subject;
  searchValue.str = value;
  term.value = searchValue;
  filter.appendTerm(term);
  return filter.MatchHdr(conditionalHeader, inbox, inbox.msgDatabase, "");
}

add_task(function test_conditionalSubjectMatch() {
  Assert.ok(matchConditionalSubject("needle"));
});
add_task(function test_conditionalSubjectNonMatch() {
  Assert.ok(!matchConditionalSubject("unrelated"));
});

add_task(async function test_conditionalLegacySearchPolicyUnchanged() {
  const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(
    Ci.nsIMsgSearchSession
  );
  const filter = conditionalFilter([
    { value: "error-one" },
    { value: "true", and: false },
  ]);
  session.searchTerms = filter.searchTerms;
  session.addScopeTerm(
    Ci.nsMsgSearchScope.offlineMail,
    localAccountUtils.inboxFolder
  );
  const hits = [];
  let stopped;
  const done = new Promise(resolve => {
    stopped = resolve;
  });
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchNotify"]),
    onNewSearch() {},
    onSearchHit(header) {
      hits.push(header.messageKey);
    },
    onSearchDone(status) {
      stopped(status);
    },
  };
  session.registerListener(listener, Ci.nsIMsgSearchSession.allNotifications);
  conditionalCalls.length = 0;
  try {
    session.search(null);
    Assert.equal(await done, Cr.NS_OK);
    Assert.deepEqual(hits, [conditionalHeader.messageKey]);
    Assert.deepEqual(conditionalCalls, ["error-one", "true"]);
  } finally {
    session.unregisterListener(listener);
  }
});
