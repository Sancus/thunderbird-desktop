/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head.js */

do_get_profile();

let rootFolder;

add_setup(function () {
  const account = MailServices.accounts.createLocalMailAccount();
  rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const backend = service instanceof Ci.nsIDatabaseCore ? "panorama" : "mork";
  Assert.equal(
    backend,
    Services.prefs.getBoolPref("mail.panorama.enabled", false)
      ? "panorama"
      : "mork",
    "The actual message DB service matches the declared backend"
  );
  const contract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID",
    "@mozilla.org/msgstore/berkeleystore;1"
  );
  Assert.ok(
    [
      "@mozilla.org/msgstore/berkeleystore;1",
      "@mozilla.org/msgstore/maildirstore;1",
    ].includes(contract),
    "The declared store constructor is supported"
  );
  Assert.equal(
    account.incomingServer.getStringValue("storeContractID"),
    contract
  );
  Assert.equal(
    rootFolder.msgStore.storeType,
    contract == "@mozilla.org/msgstore/maildirstore;1" ? "maildir" : "mbox"
  );
  info(
    "S373_FILTER_FIXTURE " +
      JSON.stringify({
        backend,
        store: rootFolder.msgStore.storeType,
        contract,
        serverContract:
          account.incomingServer.getStringValue("storeContractID"),
      })
  );
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
});

/**
 * Create a real message in the filter source folder.
 *
 * @param {nsIMsgLocalMailFolder} folder - The source folder.
 * @param {string} id - The Message-ID.
 * @param {string} subject - The subject.
 * @returns {nsIMsgDBHdr} The stored header.
 */
function addMessage(folder, id, subject) {
  const header = folder.addMessage(
    "From: sender@example.invalid\r\n" +
      "To: recipient@example.invalid\r\n" +
      `Message-ID: <${id}>\r\nSubject: ${subject}\r\n\r\nBody.\r\n`
  );
  Assert.equal(header.messageId, id);
  return header;
}

/**
 * Create an enabled manual filter matching the literal subject token.
 *
 * @param {nsIMsgFilterList} list - The temporary filter list.
 * @param {string} name - The rule name.
 * @returns {nsIMsgFilter} The rule inserted at the end of the list.
 */
function makeFilter(list, name) {
  const filter = list.createFilter(name);
  filter.enabled = true;
  filter.filterType = Ci.nsMsgFilterType.Manual;
  const term = filter.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Subject;
  term.op = Ci.nsMsgSearchOp.Contains;
  const value = term.value;
  value.attrib = Ci.nsMsgSearchAttrib.Subject;
  value.str = "match";
  term.value = value;
  term.booleanAnd = true;
  filter.appendTerm(term);
  list.insertFilterAt(list.filterCount, filter);
  return filter;
}

/**
 * Run the real manual-filter pipeline with an existing async custom action.
 *
 * @param {string} name - Unique fixture and action name.
 * @param {nsresult} status - The custom action's completion status.
 * @param {boolean} synchronous - Complete inside applyAction.
 * @param {boolean} [reenter=false] - Call back from operation completion.
 * @returns {Promise<object>} The listener and captured completion records.
 */
async function runFilters(name, status, synchronous, reenter = false) {
  const folder = rootFolder
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const target = addMessage(
    folder,
    `${name}-target@filter.invalid`,
    "match this"
  );
  const excluded = addMessage(
    folder,
    `${name}-excluded@filter.invalid`,
    "leave alone"
  );
  let copyListener;
  const actions = [];
  const action = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
    id: `${name}@filter.invalid#completion`,
    name,
    allowDuplicates: false,
    isAsync: true,
    needsBody: false,
    isValidForType() {
      return true;
    },
    validateActionValue() {
      return "";
    },
    applyAction(headers, value, listener) {
      actions.push(
        headers.map(header => [
          header.folder.URI,
          header.messageKey,
          header.messageId,
        ])
      );
      copyListener = listener;
      if (synchronous) {
        listener.onStopCopy(status);
      } else {
        Services.tm.dispatchToMainThread(() => listener.onStopCopy(status));
      }
    },
  };
  MailServices.filters.addCustomAction(action);
  registerCleanupFunction(() => {
    copyListener = null;
  });
  const list = MailServices.filters.getTempFilterList(folder);
  const first = makeFilter(list, "custom completion");
  const custom = first.createAction();
  custom.type = Ci.nsMsgFilterAction.Custom;
  custom.customId = action.id;
  first.appendAction(custom);
  const second = makeFilter(list, "later rule");
  const flag = second.createAction();
  flag.type = Ci.nsMsgFilterAction.MarkFlagged;
  second.appendAction(flag);

  const stopped = Promise.withResolvers();
  const completions = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgOperationListener"]),
    onStopOperation(result) {
      completions.push(result);
      if (reenter && completions.length == 1) {
        copyListener.onStopCopy(Cr.NS_OK);
      }
      stopped.resolve();
    },
  };
  MailServices.filters.applyFiltersToFolders(list, [folder], null, listener);
  await stopped.promise;
  Assert.deepEqual(
    completions,
    [status],
    "One operation completion preserves the result"
  );
  Assert.deepEqual(actions, [
    [[folder.URI, target.messageKey, `${name}-target@filter.invalid`]],
  ]);
  Assert.ok(
    folder.msgDatabase.getMsgHdrForKey(target.messageKey).isFlagged,
    "The later rule ran"
  );
  Assert.ok(
    !folder.msgDatabase.getMsgHdrForKey(excluded.messageKey).isFlagged,
    "The excluded message was untouched"
  );
  Assert.deepEqual(
    Array.from(folder.messages, header => header.messageId).sort(),
    [`${name}-excluded@filter.invalid`, `${name}-target@filter.invalid`],
    "Both physical source messages remain"
  );
  return { copyListener, completions, actions };
}

add_task(async function test_late_custom_completion_notifies_once() {
  const { copyListener, completions, actions } = await runFilters(
    "asyncSuccess",
    Cr.NS_OK,
    false
  );
  copyListener.onStopCopy(Cr.NS_OK);
  copyListener.onStopCopy(Cr.NS_ERROR_FAILURE);
  Assert.deepEqual(completions, [Cr.NS_OK]);
  Assert.equal(actions.length, 1, "Late completion does not restart actions");
});

add_task(async function test_headless_custom_failure_preserves_error() {
  const { copyListener, completions } = await runFilters(
    "asyncFailure",
    Cr.NS_ERROR_FILE_ACCESS_DENIED,
    false
  );
  copyListener.onStopCopy(Cr.NS_OK);
  Assert.deepEqual(completions, [Cr.NS_ERROR_FILE_ACCESS_DENIED]);
});

add_task(async function test_synchronous_custom_completion_finishes_once() {
  const { copyListener, completions, actions } = await runFilters(
    "syncSuccess",
    Cr.NS_OK,
    true
  );
  copyListener.onStopCopy(Cr.NS_OK);
  Assert.deepEqual(completions, [Cr.NS_OK]);
  Assert.equal(actions.length, 1);
});

add_task(async function test_reentrant_operation_completion_notifies_once() {
  const { completions, actions } = await runFilters(
    "reentrantSuccess",
    Cr.NS_OK,
    false,
    true
  );
  Assert.deepEqual(completions, [Cr.NS_OK]);
  Assert.equal(actions.length, 1);
});

/**
 * Keep a later action pending after a synchronous callback followed by failure.
 *
 * @param {boolean} messageList - Use applyFilters instead of folder search.
 */
async function checkSynchronousCallbackThenFailure(messageList) {
  const prefix = messageList ? "syncFailureMessages" : "syncFailureFolder";
  const folder = rootFolder
    .createLocalSubfolder(prefix)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const target = addMessage(
    folder,
    prefix + "-target@filter.invalid",
    "match this"
  );
  const excluded = addMessage(
    folder,
    prefix + "-excluded@filter.invalid",
    "leave alone"
  );
  const list = messageList
    ? folder.getFilterList(null)
    : MailServices.filters.getTempFilterList(folder);
  const events = [];
  const waiting = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const completions = [];
  let pendingListener;
  const filters = [];
  for (const [name, isAsync, apply] of [
    [
      "first",
      true,
      (headers, listener) => {
        listener.onStopCopy(Cr.NS_ERROR_FILE_ACCESS_DENIED);
        throw new Components.Exception(
          "Failed after callback",
          Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      },
    ],
    [
      "waiting",
      true,
      (headers, listener) => {
        pendingListener = listener;
        waiting.resolve();
      },
    ],
    ["last", false, headers => folder.markMessagesFlagged(headers, true)],
  ]) {
    const custom = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
      id: `${prefix}@filter.invalid#${name}`,
      name,
      allowDuplicates: false,
      isAsync,
      needsBody: false,
      isValidForType() {
        return true;
      },
      validateActionValue() {
        return "";
      },
      applyAction(headers, value, listener) {
        events.push(name);
        apply(headers, listener);
      },
    };
    MailServices.filters.addCustomAction(custom);
    const filter = makeFilter(list, name);
    filters.push(filter);
    const action = filter.createAction();
    action.type = Ci.nsMsgFilterAction.Custom;
    action.customId = custom.id;
    filter.appendAction(action);
  }
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgOperationListener"]),
    onStopOperation(status) {
      completions.push(status);
      stopped.resolve();
    },
  };
  try {
    if (messageList) {
      MailServices.filters.applyFilters(
        Ci.nsMsgFilterType.Manual,
        [target, excluded],
        [],
        folder,
        null,
        listener
      );
    } else {
      MailServices.filters.applyFiltersToFolders(
        list,
        [folder],
        null,
        listener
      );
    }
    await Promise.race([waiting.promise, stopped.promise]);
    Assert.deepEqual(events, ["first", "waiting"]);
    Assert.deepEqual(completions, [], "The later action is still pending");
    Assert.ok(!folder.msgDatabase.getMsgHdrForKey(target.messageKey).isFlagged);
    if (messageList) {
      Assert.throws(
        () => pendingListener.onStopCopy(Cr.NS_OK),
        error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED,
        "Synchronous terminal continuation returns the original failure"
      );
    } else {
      pendingListener.onStopCopy(Cr.NS_OK);
    }
    await stopped.promise;
    Assert.deepEqual(events, ["first", "waiting", "last"]);
    Assert.deepEqual(completions, [Cr.NS_ERROR_FILE_ACCESS_DENIED]);
    Assert.ok(folder.msgDatabase.getMsgHdrForKey(target.messageKey).isFlagged);
    Assert.ok(
      !folder.msgDatabase.getMsgHdrForKey(excluded.messageKey).isFlagged
    );
    Assert.deepEqual(
      Array.from(folder.messages, header => header.messageId).sort(),
      [prefix + "-excluded@filter.invalid", prefix + "-target@filter.invalid"],
      "No physical source message was removed"
    );
    pendingListener.onStopCopy(Cr.NS_ERROR_FAILURE);
    Assert.deepEqual(events, ["first", "waiting", "last"]);
    Assert.deepEqual(completions, [Cr.NS_ERROR_FILE_ACCESS_DENIED]);
  } finally {
    for (const filter of filters) {
      list.removeFilter(filter);
    }
    pendingListener = null;
  }
}

add_task(async function test_folder_filter_sync_callback_then_failure() {
  await checkSynchronousCallbackThenFailure(false);
});

add_task(async function test_message_filter_sync_callback_then_failure() {
  await checkSynchronousCallbackThenFailure(true);
});

add_task(async function test_terminal_message_filter_stops_matching() {
  const folder = rootFolder
    .createLocalSubfolder("terminalMessageFilter")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const target = addMessage(
    folder,
    "terminal-target@filter.invalid",
    "match this"
  );
  const excluded = addMessage(
    folder,
    "terminal-excluded@filter.invalid",
    "leave alone"
  );
  const list = folder.getFilterList(null);
  const filters = [];
  let copyListener;
  const capture = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
    id: "terminal@filter.invalid#capture",
    name: "Capture existing listener",
    allowDuplicates: false,
    isAsync: false,
    needsBody: false,
    isValidForType() {
      return true;
    },
    validateActionValue() {
      return "";
    },
    applyAction(headers, value, listener) {
      copyListener = listener;
    },
  };
  MailServices.filters.addCustomAction(capture);
  const first = makeFilter(list, "capture listener");
  filters.push(first);
  const captureAction = first.createAction();
  captureAction.type = Ci.nsMsgFilterAction.Custom;
  captureAction.customId = capture.id;
  first.appendAction(captureAction);
  const matches = [];
  const customTerm = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchCustomTerm"]),
    id: "terminal@filter.invalid#match",
    name: "Stop while matching",
    needsBody: false,
    getEnabled() {
      return true;
    },
    getAvailable() {
      return true;
    },
    getAvailableOperators() {
      return [Ci.nsMsgSearchOp.Is];
    },
    match(header, value) {
      matches.push([
        value,
        header.folder.URI,
        header.messageKey,
        header.messageId,
      ]);
      if (value == "stop") {
        Assert.throws(
          () =>
            copyListener
              .QueryInterface(Ci.nsIUrlListener)
              .OnStopRunningUrl(null, Cr.NS_ERROR_ABORT),
          error => error.result == Cr.NS_ERROR_ABORT
        );
      }
      return true;
    },
  };
  MailServices.filters.addCustomTerm(customTerm);
  for (const name of ["stop", "after"]) {
    const filter = list.createFilter(name);
    filters.push(filter);
    filter.enabled = true;
    filter.filterType = Ci.nsMsgFilterType.Manual;
    const term = filter.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.Custom;
    term.customId = customTerm.id;
    term.op = Ci.nsMsgSearchOp.Is;
    term.booleanAnd = true;
    const value = term.value;
    value.attrib = Ci.nsMsgSearchAttrib.Custom;
    value.str = name;
    term.value = value;
    filter.appendTerm(term);
    const action = filter.createAction();
    action.type = Ci.nsMsgFilterAction.MarkFlagged;
    filter.appendAction(action);
    list.insertFilterAt(list.filterCount, filter);
  }
  const completions = [];
  const stopped = Promise.withResolvers();
  try {
    Assert.throws(
      () =>
        MailServices.filters.applyFilters(
          Ci.nsMsgFilterType.Manual,
          [target, excluded],
          [],
          folder,
          null,
          {
            QueryInterface: ChromeUtils.generateQI(["nsIMsgOperationListener"]),
            onStopOperation(status) {
              completions.push(status);
              stopped.resolve();
            },
          }
        ),
      error => error.result == Cr.NS_ERROR_ABORT,
      "Synchronous terminal failure also reaches the caller"
    );
    await stopped.promise;
    Assert.deepEqual(completions, [Cr.NS_ERROR_ABORT]);
    Assert.deepEqual(matches, [
      ["stop", folder.URI, target.messageKey, "terminal-target@filter.invalid"],
    ]);
    Assert.ok(!folder.msgDatabase.getMsgHdrForKey(target.messageKey).isFlagged);
    Assert.ok(
      !folder.msgDatabase.getMsgHdrForKey(excluded.messageKey).isFlagged
    );
  } finally {
    for (const filter of filters) {
      list.removeFilter(filter);
    }
    copyListener = null;
  }
});

/**
 * Check a failure that finishes inside the initial public service call.
 *
 * @param {boolean} withListener - Also observe the optional operation callback.
 */
function checkSynchronousFailureResult(withListener) {
  const name = withListener
    ? "syncErrorWithListener"
    : "syncErrorWithoutListener";
  const folder = rootFolder
    .createLocalSubfolder(name)
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const target = addMessage(
    folder,
    name + "-target@filter.invalid",
    "match this"
  );
  const excluded = addMessage(
    folder,
    name + "-excluded@filter.invalid",
    "leave alone"
  );
  const list = folder.getFilterList(null);
  const completions = [];
  let calls = 0;
  const custom = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
    id: name + "@filter.invalid#failure",
    name,
    allowDuplicates: false,
    isAsync: true,
    needsBody: false,
    isValidForType() {
      return true;
    },
    validateActionValue() {
      return "";
    },
    applyAction(headers, value, listener) {
      calls++;
      Assert.deepEqual(
        headers.map(header => [header.folder.URI, header.messageKey]),
        [[folder.URI, target.messageKey]]
      );
      listener.onStopCopy(Cr.NS_ERROR_FILE_ACCESS_DENIED);
    },
  };
  MailServices.filters.addCustomAction(custom);
  const filter = makeFilter(list, name);
  const action = filter.createAction();
  action.type = Ci.nsMsgFilterAction.Custom;
  action.customId = custom.id;
  filter.appendAction(action);
  const listener = withListener
    ? {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgOperationListener"]),
        onStopOperation(status) {
          completions.push(status);
        },
      }
    : null;
  try {
    Assert.throws(
      () =>
        MailServices.filters.applyFilters(
          Ci.nsMsgFilterType.Manual,
          [target, excluded],
          [],
          folder,
          null,
          listener
        ),
      error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED,
      "The public call preserves its synchronous terminal error"
    );
    Assert.equal(calls, 1);
    Assert.deepEqual(
      completions,
      withListener ? [Cr.NS_ERROR_FILE_ACCESS_DENIED] : []
    );
    Assert.deepEqual(
      Array.from(folder.messages, header => [
        header.messageKey,
        header.messageId,
      ]),
      [
        [target.messageKey, name + "-target@filter.invalid"],
        [excluded.messageKey, name + "-excluded@filter.invalid"],
      ],
      "The matched and excluded physical messages remain"
    );
  } finally {
    list.removeFilter(filter);
  }
}

add_task(function test_synchronous_failure_reaches_caller_and_listener() {
  checkSynchronousFailureResult(true);
});

add_task(function test_synchronous_failure_reaches_caller_without_listener() {
  checkSynchronousFailureResult(false);
});

add_task(async function test_selected_physical_filter_headers() {
  for (const mode of ["success", "actionFailure", "matchFailure"]) {
    const failing = mode != "success";
    const name = "selected" + mode;
    const folder = rootFolder
      .createLocalSubfolder(name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const outside = rootFolder
      .createLocalSubfolder(name + "Outside")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const id = name + "@filter.invalid";
    const first = addMessage(folder, id, "match first");
    const second = addMessage(folder, id, "match second");
    const unselected = addMessage(folder, id, "match unselected");
    const nonmatching = addMessage(folder, id, "excluded subject");
    const foreign = addMessage(outside, id, "match outside");
    Assert.notEqual(first.messageKey, second.messageKey);
    const list = folder.getFilterList(null);
    const rules = [];
    const captures = [];
    const completions = [];
    const stopped = Promise.withResolvers();
    for (const [index, status] of [
      failing ? Cr.NS_ERROR_FILE_ACCESS_DENIED : Cr.NS_OK,
      failing ? Cr.NS_ERROR_ABORT : Cr.NS_OK,
    ].entries()) {
      const custom = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgFilterCustomAction"]),
        id: `${name}@filter.invalid#${index}`,
        name: name + index,
        allowDuplicates: false,
        isAsync: false,
        needsBody: false,
        isValidForType() {
          return true;
        },
        validateActionValue() {
          return "";
        },
        applyAction(headers) {
          captures.push(
            headers.map(header => [header.folder.URI, header.messageKey])
          );
          if (!Components.isSuccessCode(status)) {
            throw Components.Exception("selected action failure", status);
          }
        },
      };
      MailServices.filters.addCustomAction(custom);
      const rule = makeFilter(list, custom.name);
      if (mode == "matchFailure" && index == 0) {
        const termId = name + "@filter.invalid#match";
        MailServices.filters.addCustomTerm({
          QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchCustomTerm"]),
          id: termId,
          name: "Selected physical matcher failure",
          needsBody: false,
          getEnabled() {
            return true;
          },
          getAvailable() {
            return true;
          },
          getAvailableOperators() {
            return [Ci.nsMsgSearchOp.Is];
          },
          match(header) {
            Assert.equal(header.folder, folder);
            Assert.ok(
              [
                first.messageKey,
                nonmatching.messageKey,
                second.messageKey,
              ].includes(header.messageKey),
              "Only selected physical headers reach the matcher"
            );
            throw Components.Exception(
              "selected match refused",
              Cr.NS_ERROR_FILE_ACCESS_DENIED
            );
          },
        });
        const term = rule.createTerm();
        term.attrib = Ci.nsMsgSearchAttrib.Custom;
        term.customId = termId;
        term.op = Ci.nsMsgSearchOp.Is;
        term.booleanAnd = true;
        const value = term.value;
        value.attrib = Ci.nsMsgSearchAttrib.Custom;
        value.str = "match";
        term.value = value;
        rule.appendTerm(term);
      }
      rules.push(rule);
      const action = rule.createAction();
      action.type = Ci.nsMsgFilterAction.Custom;
      action.customId = custom.id;
      rule.appendAction(action);
    }
    const flagRule = makeFilter(list, name + "flag");
    rules.push(flagRule);
    const flag = flagRule.createAction();
    flag.type = Ci.nsMsgFilterAction.MarkFlagged;
    flagRule.appendAction(flag);
    try {
      Assert.deepEqual(
        Array.from(
          folder.msgDatabase.getFilterEnumerator(flagRule.searchTerms),
          header => [header.folder.URI, header.messageKey]
        ),
        [first, second, unselected].map(header => [
          folder.URI,
          header.messageKey,
        ]),
        "The existing enumerator finds all and only physical folder matches"
      );
      const run = () =>
        MailServices.filters.applyFilters(
          Ci.nsMsgFilterType.Manual,
          [first, nonmatching, second],
          [],
          folder,
          null,
          {
            QueryInterface: ChromeUtils.generateQI(["nsIMsgOperationListener"]),
            onStopOperation(status) {
              completions.push(status);
              stopped.resolve();
            },
          }
        );
      if (failing) {
        Assert.throws(
          run,
          error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
        );
      } else {
        run();
      }
      await stopped.promise;
      Assert.deepEqual(
        completions,
        [failing ? Cr.NS_ERROR_FILE_ACCESS_DENIED : Cr.NS_OK],
        "Later failures preserve the first error and one completion"
      );
      Assert.deepEqual(
        captures,
        (mode == "matchFailure" ? [1] : [0, 1]).map(() =>
          [first, second].map(header => [folder.URI, header.messageKey])
        ),
        "The matcher acts only on the selected physical copies"
      );
      for (const header of [first, second]) {
        Assert.ok(
          folder.msgDatabase.getMsgHdrForKey(header.messageKey).isFlagged
        );
      }
      for (const header of [unselected, nonmatching]) {
        Assert.ok(
          !folder.msgDatabase.getMsgHdrForKey(header.messageKey).isFlagged
        );
      }
      Assert.ok(
        !outside.msgDatabase.getMsgHdrForKey(foreign.messageKey).isFlagged
      );
      Assert.equal(folder.getTotalMessages(false), 4);
      Assert.equal(outside.getTotalMessages(false), 1);
    } finally {
      for (const rule of rules) {
        list.removeFilter(rule);
      }
    }
  }
});

add_task(async function test_filter_move_delete_settlement() {
  const { MockRegistrar } = ChromeUtils.importESModule(
    "resource://testing-common/MockRegistrar.sys.mjs"
  );
  const { mailTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
  );
  for (const type of [
    Ci.nsMsgFilterAction.MoveToFolder,
    Ci.nsMsgFilterAction.Delete,
  ]) {
    for (const mode of ["success", "startFailure", "terminalFailure"]) {
      const name = `settlement${type}${mode}`;
      const folder = rootFolder
        .createLocalSubfolder(name)
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      const target = addMessage(folder, name + "@filter.invalid", "match this");
      const excluded = addMessage(
        folder,
        name + "-excluded@filter.invalid",
        "leave alone"
      );
      const originalKey = target.messageKey;
      const originalToken = target.storeToken;
      const originalBody = mailTestUtils.loadMessageToString(folder, target);
      let destination;
      if (type == Ci.nsMsgFilterAction.Delete) {
        destination = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
        if (!destination) {
          destination = rootFolder.createLocalSubfolder("Trash");
          destination.setFlag(Ci.nsMsgFolderFlags.Trash);
        }
      } else {
        destination = rootFolder.createLocalSubfolder(name + "Destination");
      }
      Assert.equal(destination.msgStore.storeType, folder.msgStore.storeType);
      const beforeKeys = Array.from(
        destination.messages,
        header => header.messageKey
      );
      const list = folder.getFilterList(null);
      const rule = makeFilter(list, name);
      const action = rule.createAction();
      action.type = type;
      if (type == Ci.nsMsgFilterAction.MoveToFolder) {
        action.targetFolderUri = destination.URI;
      }
      rule.appendAction(action);
      const contract = "@mozilla.org/messenger/messagecopyservice;1";
      const nativeCopy = Cc[contract].getService(Ci.nsIMsgCopyService);
      const providerStopped = Promise.withResolvers();
      const stopped = Promise.withResolvers();
      const completions = [];
      let copyCalls = 0;
      let release;
      const proxy = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyService"]),
        copyMessages(
          source,
          headers,
          targetFolder,
          move,
          listener,
          window,
          undo
        ) {
          copyCalls++;
          Assert.equal(source, folder);
          Assert.equal(targetFolder, destination);
          Assert.ok(move);
          Assert.ok(!undo);
          Assert.deepEqual(
            headers.map(header => [header.folder.URI, header.messageKey]),
            [[folder.URI, originalKey]]
          );
          if (mode == "startFailure") {
            providerStopped.resolve(Cr.NS_ERROR_FILE_ACCESS_DENIED);
            throw Components.Exception(
              "filter copy start refused",
              Cr.NS_ERROR_FILE_ACCESS_DENIED
            );
          }
          if (mode == "terminalFailure") {
            // An explicit copy-service failure control. No native transfer or
            // successful destination publication is claimed for this input.
            Services.tm.dispatchToMainThread(() => {
              providerStopped.resolve(Cr.NS_ERROR_FILE_ACCESS_DENIED);
              Assert.throws(
                () => listener.onStopCopy(Cr.NS_ERROR_FILE_ACCESS_DENIED),
                error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
              );
              listener.onStopCopy(Cr.NS_OK);
            });
            return;
          }
          nativeCopy.copyMessages(
            source,
            headers,
            targetFolder,
            move,
            {
              QueryInterface: ChromeUtils.generateQI([
                "nsIMsgCopyServiceListener",
              ]),
              onStartCopy() {
                listener.onStartCopy();
              },
              onProgress(...args) {
                listener.onProgress(...args);
              },
              setMessageKey(key) {
                listener.setMessageKey(key);
              },
              getMessageId() {
                return listener.getMessageId();
              },
              onStopCopy(status) {
                release = () => listener.onStopCopy(status);
                providerStopped.resolve(status);
              },
            },
            window,
            undo
          );
        },
        copyFolder(...args) {
          nativeCopy.copyFolder(...args);
        },
        copyFileMessage(...args) {
          nativeCopy.copyFileMessage(...args);
        },
        notifyCompletion(...args) {
          nativeCopy.notifyCompletion(...args);
        },
        getArrivedFolder(...args) {
          return nativeCopy.getArrivedFolder(...args);
        },
      };
      const cid = MockRegistrar.register(contract, proxy);
      try {
        const run = () =>
          MailServices.filters.applyFilters(
            Ci.nsMsgFilterType.Manual,
            [target, excluded],
            [],
            folder,
            null,
            {
              QueryInterface: ChromeUtils.generateQI([
                "nsIMsgOperationListener",
              ]),
              onStopOperation(status) {
                completions.push(status);
                stopped.resolve();
              },
            }
          );
        if (mode == "startFailure") {
          Assert.throws(
            run,
            error => error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED
          );
        } else {
          run();
        }
        const status = await providerStopped.promise;
        if (mode == "success") {
          Assert.equal(status, Cr.NS_OK, "The real native transfer succeeded");
          Assert.deepEqual(
            completions,
            [],
            "The filter waits for confirmed completion"
          );
          Assert.ok(release);
          release();
        }
        await stopped.promise;
        Assert.deepEqual(completions, [
          mode == "success" ? Cr.NS_OK : Cr.NS_ERROR_FILE_ACCESS_DENIED,
        ]);
        Assert.equal(copyCalls, 1, "The action was dispatched once");
        const arrived = Array.from(destination.messages).filter(
          header => !beforeKeys.includes(header.messageKey)
        );
        if (mode == "success") {
          Assert.equal(
            arrived.length,
            1,
            "Exactly one confirmed physical destination"
          );
          Assert.equal(arrived[0].messageId, name + "@filter.invalid");
          Assert.equal(
            mailTestUtils.loadMessageToString(destination, arrived[0]),
            originalBody
          );
          Assert.deepEqual(
            Array.from(folder.messages, header => header.messageKey),
            [excluded.messageKey]
          );
          release();
          Assert.deepEqual(
            completions,
            [Cr.NS_OK],
            "Late copy completion cannot replay the action"
          );
        } else {
          Assert.deepEqual(
            arrived,
            [],
            "No destination was published on failure"
          );
          const retained = folder.msgDatabase.getMsgHdrForKey(originalKey);
          Assert.equal(retained.storeToken, originalToken);
          Assert.equal(
            mailTestUtils.loadMessageToString(folder, retained),
            originalBody
          );
          Assert.deepEqual(
            Array.from(folder.messages, header => header.messageKey),
            [originalKey, excluded.messageKey],
            "Both original physical sources remain"
          );
        }
      } finally {
        MockRegistrar.unregister(cid);
        list.removeFilter(rule);
        release = null;
      }
    }
  }
});
