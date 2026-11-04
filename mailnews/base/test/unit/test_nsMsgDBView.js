/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Attempt to test nsMsgDBView and descendants.  Right now this means we:
 * - Ensure sorting and grouping sorta works, including using custom columns.
 *
 * Things we really should do:
 * - Test that secondary sorting works, especially when the primary column is
 *   a custom column.
 *
 * You may also want to look into the test_viewWrapper_*.js tests as well.
 */

var { MessageGenerator, MessageScenarioFactory, SyntheticMessageSet } =
  ChromeUtils.importESModule(
    "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
  );
const { TreeSelection } = ChromeUtils.importESModule(
  "chrome://messenger/content/TreeSelection.mjs"
);
var { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);
var { dump_view_contents } = ChromeUtils.importESModule(
  "resource://testing-common/mail/ViewHelpers.sys.mjs"
);

// Items used to add messages to the folder
var gMessageGenerator = new MessageGenerator();
var gScenarioFactory = new MessageScenarioFactory(gMessageGenerator);
var messageInjection = new MessageInjection({ mode: "local" });

var gTestFolder;
var gSiblingsMissingParentsSubject;

function setup_messages() {
  // build up a diverse list of messages
  let messages = [];
  messages = messages.concat(gScenarioFactory.directReply(10));
  // the message generator uses a constanty incrementing counter, so we need to
  //  mix up the order of messages ourselves to ensure that the timestamp
  //  ordering is not already in order.  (a poor test of sorting otherwise.)
  messages = gScenarioFactory.directReply(6).concat(messages);

  messages = messages.concat(gScenarioFactory.fullPyramid(3, 3));
  const siblingMessages = gScenarioFactory.siblingsMissingParent();
  // cut off "Re: " part
  gSiblingsMissingParentsSubject = siblingMessages[0].subject.slice(4);
  dump("siblings subect = " + gSiblingsMissingParentsSubject + "\n");
  messages = messages.concat(siblingMessages);
  messages = messages.concat(gScenarioFactory.missingIntermediary());
  // This next line was found to be faulty during linting, but fixing it breaks the test.
  // messages.concat(gMessageGenerator.makeMessage({age: {days: 2, hours: 1}}));

  // build a hierarchy like this (the UID order corresponds to the date order)
  //   1
  //    2
  //     4
  //    3
  const msg1 = gMessageGenerator.makeMessage();
  const msg2 = gMessageGenerator.makeMessage({ inReplyTo: msg1 });
  const msg3 = gMessageGenerator.makeMessage({ inReplyTo: msg1 });
  const msg4 = gMessageGenerator.makeMessage({ inReplyTo: msg2 });
  messages = messages.concat([msg1, msg2, msg3, msg4]);

  // test bug 600140, make a thread that Reply message has smaller MsgKey
  const msgBiggerKey = gMessageGenerator.makeMessage();
  const msgSmallerKey = gMessageGenerator.makeMessage({
    inReplyTo: msgBiggerKey,
  });
  messages = messages.concat([msgSmallerKey, msgBiggerKey]);
  const msgSet = new SyntheticMessageSet(messages);
  return msgSet;
}

/**
 * Set gTestFolder to a new folder and store the supplied messages.
 *
 * @param {SyntheticMessageSet} [msgSet] - Defaults to a fresh message scenario.
 * @returns {Promise<void>}
 */
async function set_gTestFolder(msgSet = setup_messages()) {
  gTestFolder = await messageInjection.makeEmptyFolder();
  await messageInjection.addSetsToFolders([gTestFolder], [msgSet]);
}

/**
 * Create a synthetic message by passing the provided aMessageArgs to
 *  the message generator, then add the resulting message to the given
 *  folder (or gTestFolder if no folder is provided).
 */
async function make_and_add_message(aMessageArgs) {
  // create the message
  const synMsg = gMessageGenerator.makeMessage(aMessageArgs);
  const msgSet = new SyntheticMessageSet([synMsg]);
  // this is synchronous for local stuff.
  await messageInjection.addSetsToFolders([gTestFolder], [msgSet]);

  return [synMsg, msgSet];
}

function view_throw(why) {
  dump_view_contents({ dbView: gDBView });
  do_throw(why);
}

/**
 * Throw if gDBView has any rows.
 */
function assert_view_empty() {
  if (gTreeView.rowCount != 0) {
    view_throw(
      "Expected view to be empty, but it was not! (" +
        gTreeView.rowCount +
        " rows)"
    );
  }
}

/**
 * Throw if gDBView does not have aCount rows.
 */
function assert_view_row_count(aCount) {
  if (gTreeView.rowCount != aCount) {
    view_throw(
      "Expected view to have " +
        aCount +
        " rows, but it had " +
        gTreeView.rowCount +
        " rows!"
    );
  }
}

/**
 * Throw if any of the arguments (as view indices) do not correspond to dummy
 *  rows in gDBView.
 */
function assert_view_index_is_dummy(...aArgs) {
  for (const viewIndex of aArgs) {
    const flags = gDBView.getFlagsAt(viewIndex);
    if (!(flags & MSG_VIEW_FLAG_DUMMY)) {
      view_throw("Expected index " + viewIndex + " to be a dummy!");
    }
  }
}

/**
 * Throw if any of the arguments (as view indices) correspond to dummy rows in
 *  gDBView.
 */
function assert_view_index_is_not_dummy(...aArgs) {
  for (const viewIndex of aArgs) {
    const flags = gDBView.getFlagsAt(viewIndex);
    if (flags & MSG_VIEW_FLAG_DUMMY) {
      view_throw("Expected index " + viewIndex + " to not be a dummy!");
    }
  }
}

function assert_view_level_is(index, level) {
  if (gDBView.getLevel(index) != level) {
    view_throw(
      "Expected index " +
        index +
        " to be level " +
        level +
        " not " +
        gDBView.getLevel(index)
    );
  }
}

/**
 * Returns a header's physical location and Message-ID.
 *
 * @param {nsIMsgDBHdr} header - The stored header.
 * @returns {[string, number, string]} Folder URI, key and Message-ID.
 */
function physicalIdentity(header) {
  return [header.folder.URI, header.messageKey, header.messageId];
}

/**
 * Given a message, assert that it is present at the given indices.
 *
 * Usage:
 *  assert_view_message_at_indices(synMsg, 0);
 *  assert_view_message_at_indices(synMsg, 0, 1);
 *  assert_view_message_at_indices(aMsg, 0, bMsg, 1);
 */
function assert_view_message_at_indices(...aArgs) {
  let curHdr;
  for (const thing of aArgs) {
    if (typeof thing == "number") {
      const hdrAt = gDBView.getMsgHdrAt(thing);
      if (
        curHdr.folder.URI != hdrAt.folder.URI ||
        curHdr.messageKey != hdrAt.messageKey ||
        curHdr.messageId != hdrAt.messageId
      ) {
        view_throw(
          "Expected hdr at " +
            thing +
            " to be " +
            curHdr.messageKey +
            ":" +
            curHdr.mime2DecodedSubject.substr(0, 30) +
            " not " +
            hdrAt.messageKey +
            ":" +
            hdrAt.mime2DecodedSubject.substr(0, 30)
        );
      }
    } else {
      // synthetic message, get the header...
      curHdr = gTestFolder.msgDatabase.getMsgHdrForMessageID(thing.messageId);
    }
  }
}

var authorFirstLetterCustomColumn = {
  getCellText(row) {
    const msgHdr = this.dbView.getMsgHdrAt(row);
    return msgHdr.mime2DecodedAuthor.charAt(0).toUpperCase() || "?";
  },
  getSortStringForRow(msgHdr) {
    // charAt(0) is a quote, charAt(1) is the first letter!
    return msgHdr.mime2DecodedAuthor.charAt(1).toUpperCase() || "?";
  },
  isString() {
    return true;
  },

  getCellProperties() {
    return "";
  },
  getRowProperties() {
    return "";
  },
  getImageSrc() {
    return null;
  },
  getSortLongForRow() {
    return 0;
  },
};

var gDBView;
var gTreeView;

var MSG_VIEW_FLAG_DUMMY = 0x20000000;

var gFakeSelection = new TreeSelection(null);

function setup_view(aViewType, aViewFlags, aTestFolder) {
  const dbviewContractId =
    "@mozilla.org/messenger/msgdbview;1?type=" + aViewType;

  if (aTestFolder == null) {
    aTestFolder = gTestFolder;
  }

  // always start out fully expanded
  aViewFlags |= Ci.nsMsgViewFlagsType.kExpandAll;

  gDBView = Cc[dbviewContractId].createInstance(Ci.nsIMsgDBView);
  gDBView.init(null, null);
  gDBView.open(
    aViewType != "search" ? aTestFolder : null,
    Ci.nsMsgViewSortType.byDate,
    aViewType != "search"
      ? Ci.nsMsgViewSortOrder.ascending
      : Ci.nsMsgViewSortOrder.descending,
    aViewFlags
  );

  // we need to cram messages into the search via nsIMsgSearchNotify interface
  if (
    aViewType == "search" ||
    aViewType == "quicksearch" ||
    aViewType == "xfvf"
  ) {
    const searchNotify = gDBView.QueryInterface(Ci.nsIMsgSearchNotify);
    searchNotify.onNewSearch();
    for (const msgHdr of aTestFolder.msgDatabase.enumerateMessages()) {
      searchNotify.onSearchHit(msgHdr, msgHdr.folder);
    }
    searchNotify.onSearchDone(Cr.NS_OK);
  }

  gDBView.addColumnHandler(
    "authorFirstLetterCol",
    authorFirstLetterCustomColumn
  );
  // XXX this sets the custom column to use for sorting by the custom column.
  // It has been argued (and is generally accepted) that this should not be
  // so limited.
  gDBView.curCustomColumn = "authorFirstLetterCol";

  gTreeView = gDBView.QueryInterface(Ci.nsITreeView);
  gTreeView.selection = gFakeSelection;
  gFakeSelection.view = gTreeView;
}

function setup_group_view(aSortType, aSortOrder, aTestFolder) {
  const dbviewContractId = "@mozilla.org/messenger/msgdbview;1?type=group";

  if (aTestFolder == null) {
    aTestFolder = gTestFolder;
  }

  // grouped view uses these flags
  const viewFlags =
    Ci.nsMsgViewFlagsType.kGroupBySort |
    Ci.nsMsgViewFlagsType.kExpandAll |
    Ci.nsMsgViewFlagsType.kThreadedDisplay;

  gDBView = Cc[dbviewContractId].createInstance(Ci.nsIMsgDBView);
  gDBView.init(null, null);
  var outCount = {};
  gDBView.open(aTestFolder, aSortType, aSortOrder, viewFlags, outCount);

  gDBView.addColumnHandler(
    "authorFirstLetterCol",
    authorFirstLetterCustomColumn
  );
  gDBView.curCustomColumn = "authorFirstLetterCol";

  gTreeView = gDBView.QueryInterface(Ci.nsITreeView);
  gFakeSelection.view = gTreeView;
  gTreeView.selection = gFakeSelection;
}

/**
 * Comparison func for built-in types (including strings, so no subtraction.)
 */
function generalCmp(a, b) {
  if (a < b) {
    return -1;
  } else if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Check that sort order and grouping logic (if applicable) are doing the right
 *  thing.
 *
 * In the case of groups (indicated by dummy headers), we want to ignore the
 *  dummies and 1) make sure all the values in the group have the same value,
 *  2) verify that the headers meet our total ordering.
 * In the case of threads, we want to ensure that each level of the hierarchy
 *  meets our ordering demands, recursing into children.  Because the tree
 *  representation is rather quite horrible, the easiest thing for us is to
 *  track a per-level list of comparison values we have seen, nuking older
 *  values when changes in levels indicate closure of a level.  (Namely,
 *  if we see a node at level N, then all levels >N are no longer valid.)
 *
 * @param {nsMsgViewType} aSortBy - The sort type.
 * @param {nsMsgViewSortOrder} aDirection - The sort direction.
 * @param {string|Function} aKeyOrValueGetter - A string naming the attribute on
 *   the message headerto retrieve, or if that is not sufficient a function that
 *   takes a message header and returns the sort value for it.
 * @param {Function} [aGetGroupValue] - An optional function that takes a
 *   message header and  returns the grouping value for the header.
 *   If omitted, it is assumed that the sort value is the grouping value.
 */
function ensure_view_ordering(
  aSortBy,
  aDirection,
  aKeyOrValueGetter,
  aGetGroupValue
) {
  if (!gTreeView.rowCount) {
    do_throw("There are no rows in my folder! I can't test anything!");
  }
  dump(
    "  Ensuring sort order for " +
      aSortBy +
      " (Row count: " +
      gTreeView.rowCount +
      ")\n"
  );
  dump("    cur view flags: " + gDBView.viewFlags + "\n");

  // standard grouping doesn't re-group when you sort.  so we need to actually
  //  re-initialize the view.
  // but search mode is special and does the right thing because asuth didn't
  //  realize that it shouldn't do the right thing, so it can just change the
  //  sort.  (of course, under the hood, it is actually creating a new view...)
  if (
    gDBView.viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort &&
    gDBView.viewType != Ci.nsMsgViewType.eShowSearch
  ) {
    // we must close to re-open (or we could just use a new view)
    const msgFolder = gDBView.msgFolder;
    gDBView.close();
    gDBView.open(msgFolder, aSortBy, aDirection, gDBView.viewFlags, {});
  } else {
    gDBView.sort(aSortBy, aDirection);
  }

  const comparisonValuesByLevel = [];
  const expectedLevel0CmpResult =
    aDirection == Ci.nsMsgViewSortOrder.ascending ? 1 : -1;
  const comparator = generalCmp;

  let dummyCount = 0,
    emptyDummyCount = 0;

  const valueGetter =
    typeof aKeyOrValueGetter == "string"
      ? function (msgHdr) {
          return msgHdr[aKeyOrValueGetter];
        }
      : aKeyOrValueGetter;
  const groupValueGetter = aGetGroupValue || valueGetter;

  // don't do group testing until we see a dummy header (which we will see
  //  before we see any grouped headers, so it's fine to do this)
  let inGroup = false;
  // the current grouping value for the current group.  this allows us to
  //  detect erroneous grouping of different group values together.
  let curGroupValue = null;
  // the set of group values observed before the current group.  this allows
  //  us to detect improper grouping where there are multiple groups with the
  //  same grouping value.
  const previouslySeenGroupValues = {};

  for (let iViewIndex = 0; iViewIndex < gTreeView.rowCount; iViewIndex++) {
    const msgHdr = gDBView.getMsgHdrAt(iViewIndex);
    const msgViewFlags = gDBView.getFlagsAt(iViewIndex);

    // ignore dummy headers; testing grouping logic happens elsewhere
    if (msgViewFlags & MSG_VIEW_FLAG_DUMMY) {
      if (dummyCount && curGroupValue == null) {
        emptyDummyCount++;
      }
      dummyCount++;
      if (curGroupValue != null) {
        previouslySeenGroupValues[curGroupValue] = true;
      }
      curGroupValue = null;
      inGroup = true;
      continue;
    }

    // level is 0-based
    const level = gTreeView.getLevel(iViewIndex);
    // nuke existing comparison levels
    if (level < comparisonValuesByLevel.length - 1) {
      comparisonValuesByLevel.splice(level);
    }

    // get the value for comparison
    const curValue = valueGetter(msgHdr);
    if (inGroup) {
      const groupValue = groupValueGetter(msgHdr);
      if (groupValue in previouslySeenGroupValues) {
        do_throw(`Group value ${groupValue} observed in more than one group!`);
      }
      if (curGroupValue == null) {
        curGroupValue = groupValue;
      } else if (curGroupValue != groupValue) {
        do_throw(
          "Inconsistent grouping! " + groupValue + " != " + curGroupValue
        );
      }
    }

    // is this level new to our comparisons?  then track it...
    if (level >= comparisonValuesByLevel.length) {
      // null-fill any gaps (due to, say, dummy nodes)
      while (comparisonValuesByLevel.length <= level) {
        comparisonValuesByLevel.push(null);
      }
      comparisonValuesByLevel.push(curValue);
    } else {
      // otherwise compare it
      const prevValue = comparisonValuesByLevel[level - 1];
      const cmpResult = comparator(curValue, prevValue);
      const expectedCmpResult = level > 0 ? 1 : expectedLevel0CmpResult;
      if (cmpResult && cmpResult != expectedCmpResult) {
        do_throw(
          "Ordering failure on key " +
            msgHdr.messageKey +
            ". " +
            curValue +
            " should have been " +
            (expectedCmpResult == 1 ? ">=" : "<=") +
            " " +
            prevValue +
            " but was not."
        );
      }
    }
  }

  if (inGroup && curGroupValue == null) {
    emptyDummyCount++;
  }
  if (dummyCount) {
    dump(
      "  saw " +
        dummyCount +
        " dummy headers (" +
        emptyDummyCount +
        " empty).\n"
    );
  }
}

/**
 * Test sorting functionality.
 */
function test_sort_columns() {
  ensure_view_ordering(
    Ci.nsMsgViewSortType.byDate,
    Ci.nsMsgViewSortOrder.descending,
    "date",
    function getDateAgeBucket() {
      // so, this is a cop-out, but we know that the date age bucket for our
      //  generated messages is always more than 2-weeks ago!
      return 5;
    }
  );
  ensure_view_ordering(
    Ci.nsMsgViewSortType.byDate,
    Ci.nsMsgViewSortOrder.ascending,
    "date",
    function getDateAgeBucket() {
      // so, this is a cop-out, but we know that the date age bucket for our
      //  generated messages is always more than 2-weeks ago!
      return 5;
    }
  );
  // (note, subject doesn't use dummy groups and so won't have grouping tested)
  ensure_view_ordering(
    Ci.nsMsgViewSortType.bySubject,
    Ci.nsMsgViewSortOrder.ascending,
    "mime2DecodedSubject"
  );
  ensure_view_ordering(
    Ci.nsMsgViewSortType.byAuthor,
    Ci.nsMsgViewSortOrder.ascending,
    "mime2DecodedAuthor"
  );
  // Id
  // Thread
  // Priority
  // Status
  // Size
  // Flagged
  // Unread
  ensure_view_ordering(
    Ci.nsMsgViewSortType.byRecipient,
    Ci.nsMsgViewSortOrder.ascending,
    "mime2DecodedRecipients"
  );
  // Location
  // Tags
  // JunkStatus
  // Attachments
  // Account
  // Custom
  ensure_view_ordering(
    Ci.nsMsgViewSortType.byCustom,
    Ci.nsMsgViewSortOrder.ascending,
    function (msgHdr) {
      return authorFirstLetterCustomColumn.getSortStringForRow(msgHdr);
    }
  );
  // Received
}

function test_number_of_messages() {
  // Bug 574799
  if (gDBView.numMsgsInView != gTestFolder.getTotalMessages(false)) {
    do_throw(
      "numMsgsInView is " +
        gDBView.numMsgsInView +
        " but should be " +
        gTestFolder.getTotalMessages(false) +
        "\n"
    );
  }
  // Bug 600140
  // Maybe elided so open it, now only consider the first one
  if (gDBView.isContainer(0) && !gDBView.isContainerOpen(0)) {
    gDBView.toggleOpenState(0);
  }
  let numMsgInTree = gTreeView.rowCount;
  if (gDBView.viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort) {
    for (let iViewIndex = 0; iViewIndex < gTreeView.rowCount; iViewIndex++) {
      const flags = gDBView.getFlagsAt(iViewIndex);
      if (flags & MSG_VIEW_FLAG_DUMMY) {
        numMsgInTree--;
      }
    }
  }
  if (gDBView.numMsgsInView != numMsgInTree) {
    info(
      "Stored physical thread membership: " +
        JSON.stringify(
          Array.from(gTestFolder.messages, header => ({
            key: header.messageKey,
            messageId: header.messageId,
            threadId: header.threadId,
            parent: header.threadParent,
          }))
        )
    );
    view_throw(
      "message in tree is " +
        numMsgInTree +
        " but should be " +
        gDBView.numMsgsInView +
        "\n"
    );
  }
}

function test_selected_messages() {
  gDBView.doCommand(Ci.nsMsgViewCommandType.expandAll);

  // Select one message
  gTreeView.selection.select(1);
  let selectedMessages = gDBView.getSelectedMsgHdrs();

  if (selectedMessages.length != 1) {
    do_throw(
      "getSelectedMsgHdrs.length is " +
        selectedMessages.length +
        " but should be 1\n"
    );
  }

  const firstSelectedMsg = gDBView.hdrForFirstSelectedMessage;
  Assert.ok(firstSelectedMsg, "The view returns its first selected header");
  Assert.deepEqual(
    physicalIdentity(selectedMessages[0]),
    physicalIdentity(firstSelectedMsg),
    "Both selection APIs return the same physical message"
  );

  // Select all messages
  gTreeView.selection.selectAll();
  if (gDBView.numSelected != gDBView.numMsgsInView) {
    do_throw(
      "numSelected is " +
        gDBView.numSelected +
        " but should be " +
        gDBView.numMsgsInView +
        "\n"
    );
  }

  selectedMessages = gDBView.getSelectedMsgHdrs();
  if (selectedMessages.length != gTestFolder.getTotalMessages(false)) {
    do_throw(
      "getSelectedMsgHdrs.length is " +
        selectedMessages.length +
        " but should be " +
        gTestFolder.getTotalMessages(false) +
        "\n"
    );
  }

  const expectedIdentities = [];
  for (let index = 0; index < gTreeView.rowCount; index++) {
    if (!(gDBView.getFlagsAt(index) & MSG_VIEW_FLAG_DUMMY)) {
      expectedIdentities.push(physicalIdentity(gDBView.getMsgHdrAt(index)));
    }
  }
  const compareIdentity = (left, right) =>
    left[0].localeCompare(right[0]) || left[1] - right[1];
  Assert.deepEqual(
    selectedMessages.map(physicalIdentity).sort(compareIdentity),
    expectedIdentities.sort(compareIdentity),
    "Every physical message is selected, without dummy rows or duplicates"
  );

  gTreeView.selection.clearSelection();
}

async function test_msg_added_to_search_view() {
  // if the view is a non-grouped search view, test adding a header to
  // the search results, and verify it gets put at top.
  if (!(gDBView.viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort)) {
    gDBView.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending);
    const [synMsg] = await make_and_add_message();
    const msgHdr = gTestFolder.msgDatabase.getMsgHdrForMessageID(
      synMsg.messageId
    );
    gDBView
      .QueryInterface(Ci.nsIMsgSearchNotify)
      .onSearchHit(msgHdr, msgHdr.folder);
    assert_view_message_at_indices(synMsg, 0);
  }
}

function IsHdrChildOf(possibleParent, possibleChild) {
  const parentHdrId = possibleParent.messageId;
  const numRefs = possibleChild.numReferences;
  for (let refIndex = 0; refIndex < numRefs; refIndex++) {
    if (parentHdrId == possibleChild.getStringReference(refIndex)) {
      return true;
    }
  }
  return false;
}

// This could be part of ensure_view_ordering() but I don't want to make that
// function any harder to read.
function test_threading_levels() {
  if (!gTreeView.rowCount) {
    do_throw("There are no rows in my folder! I can't test anything!");
  }
  // only look at threaded, non-grouped views.
  if (
    gDBView.viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort ||
    !(gDBView.viewFlags & Ci.nsMsgViewFlagsType.kThreadedDisplay)
  ) {
    return;
  }

  let prevLevel = 1;
  let prevMsgHdr;
  for (let iViewIndex = 0; iViewIndex < gTreeView.rowCount; iViewIndex++) {
    const msgHdr = gDBView.getMsgHdrAt(iViewIndex);
    const level = gTreeView.getLevel(iViewIndex);
    if (level > prevLevel && msgHdr.subject != gSiblingsMissingParentsSubject) {
      if (!IsHdrChildOf(prevMsgHdr, msgHdr)) {
        view_throw("indented message not child of parent");
      }
    }
    prevLevel = level;
    prevMsgHdr = msgHdr;
  }
}

function test_expand_collapse() {
  let oldRowCount = gDBView.rowCount;
  const thirdChild = gDBView.getMsgHdrAt(3);
  gDBView.toggleOpenState(0);
  if (gDBView.rowCount != oldRowCount - 9) {
    view_throw("collapsing first item should have removed 9 items");
  }

  // test that expand/collapse works with killed sub-thread.
  oldRowCount = gDBView.rowCount;
  gTestFolder.msgDatabase.markKilled(thirdChild.messageKey, true, null);
  gDBView.toggleOpenState(0);
  if (gDBView.rowCount != oldRowCount + 2) {
    view_throw("expanding first item should have added 2 items");
  }
  gTestFolder.msgDatabase.markKilled(thirdChild.messageKey, false, null);
  oldRowCount = gDBView.rowCount;
  gDBView.toggleOpenState(0);
  if (gDBView.rowCount != oldRowCount - 2) {
    view_throw("collapsing first item should have removed 2 items");
  }
}

function test_qs_results() {
  // This just tests that bug 505967 hasn't regressed.
  if (gTreeView.getLevel(0) != 0) {
    view_throw("first message should be at level 0");
  }
  if (gTreeView.getLevel(1) != 1) {
    view_throw("second message should be at level 1");
  }
  if (gTreeView.getLevel(2) != 2) {
    view_throw("third message should be at level 2");
  }
  test_threading_levels();
}

async function test_group_sort_collapseAll_expandAll_threading() {
  // - start with an empty folder
  gTestFolder = await messageInjection.makeEmptyFolder();

  // - create a normal unthreaded view
  setup_view("threaded", 0);

  // - ensure it's empty
  assert_view_empty();

  // - add 3 messages:
  // msg1: from A, custom column val A, to be starred
  // msg2: from A, custom column val A
  // msg3: from B, custom column val B
  const [smsg1] = await make_and_add_message({ from: ["A", "A@a.invalid"] });
  await make_and_add_message({ from: ["A", "A@a.invalid"] });
  const [smsg3] = await make_and_add_message({ from: ["B", "B@b.invalid"] });

  assert_view_row_count(3);
  gDBView.getMsgHdrAt(0).markFlagged(true);
  if (!gDBView.getMsgHdrAt(0).isFlagged) {
    view_throw("Expected smsg1 to be flagged");
  }

  // - create grouped view; open folder in byFlagged AZ sort
  setup_group_view(
    Ci.nsMsgViewSortType.byFlagged,
    Ci.nsMsgViewSortOrder.ascending,
    gTestFolder
  );
  // - make sure there are 5 rows; index 0 and 2 are dummy, 1 is flagged message,
  //   3-4 are messages
  assert_view_row_count(5);
  assert_view_index_is_dummy(0);
  assert_view_index_is_not_dummy(1);
  assert_view_message_at_indices(smsg1, 1);
  if (!gDBView.getMsgHdrAt(1).isFlagged) {
    view_throw("Expected grouped smsg1 to be flagged");
  }
  assert_view_index_is_dummy(2);
  assert_view_index_is_not_dummy(3);
  assert_view_index_is_not_dummy(4);

  // - collapse the grouped threads; there should be 2 dummy rows
  gDBView.doCommand(Ci.nsMsgViewCommandType.collapseAll);
  assert_view_row_count(2);
  assert_view_index_is_dummy(0);
  assert_view_index_is_dummy(1);

  // - expand the grouped threads; there should be 5 rows
  gDBView.doCommand(Ci.nsMsgViewCommandType.expandAll);
  assert_view_row_count(5);
  assert_view_index_is_dummy(0);
  assert_view_index_is_dummy(2);

  // - reverse sort; create grouped view; open folder in byFlagged ZA sort
  setup_group_view(
    Ci.nsMsgViewSortType.byFlagged,
    Ci.nsMsgViewSortOrder.descending,
    gTestFolder
  );
  // - make sure there are 5 rows; index 0 and 3 are dummy, 1-2 are messages,
  //   4 is flagged message
  assert_view_row_count(5);
  assert_view_index_is_dummy(0);
  assert_view_index_is_not_dummy(1);
  assert_view_index_is_not_dummy(2);
  assert_view_index_is_dummy(3);
  assert_view_index_is_not_dummy(4);
  assert_view_message_at_indices(smsg1, 4);
  if (!gDBView.getMsgHdrAt(4).isFlagged) {
    view_throw("Expected reverse sorted grouped smsg1 to be flagged");
  }

  // - test grouped by custom column; the custCol is first letter of author
  // - create grouped view; open folder in byCustom ZA sort
  setup_group_view(
    Ci.nsMsgViewSortType.byCustom,
    Ci.nsMsgViewSortOrder.descending,
    gTestFolder
  );

  // - make sure there are 5 rows; index 0 and 2 are dummy, 1 is B value message,
  //   3-4 are messages with A value
  assert_view_row_count(5);
  assert_view_index_is_dummy(0);
  assert_view_index_is_not_dummy(1);
  assert_view_message_at_indices(smsg3, 1);
  if (
    authorFirstLetterCustomColumn.getSortStringForRow(gDBView.getMsgHdrAt(1)) !=
    "B"
  ) {
    view_throw(
      "Expected grouped by custom column, ZA sortOrder smsg3 value to be B"
    );
  }
  assert_view_index_is_dummy(2);
  assert_view_index_is_not_dummy(3);
  assert_view_index_is_not_dummy(4);
  if (
    authorFirstLetterCustomColumn.getSortStringForRow(gDBView.getMsgHdrAt(4)) !=
    "A"
  ) {
    view_throw(
      "Expected grouped by custom column, ZA sortOrder smsg2 value to be A"
    );
  }
}

async function test_group_dummies_under_mutation_by_date() {
  // - start with an empty folder
  gTestFolder = await messageInjection.makeEmptyFolder();

  // - create the view
  setup_view("group", Ci.nsMsgViewFlagsType.kGroupBySort);
  gDBView.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.ascending);

  // - ensure it's empty
  assert_view_empty();

  // - add a message from this week
  // (we want to make sure all the messages end up in the same bucket and that
  //  the current day changing as we run the test does not change buckets
  //  either. bucket 1 is same day, bucket 2 is yesterday, bucket 3 is last
  //  week, so 2 days ago or older is always last week, even if we roll over
  //  and it becomes 3 days ago.)
  const [smsg, synSet] = await make_and_add_message({
    age: { days: 2, hours: 1 },
  });

  // - make sure the message and a dummy appear
  assert_view_row_count(2);
  assert_view_index_is_dummy(0);
  assert_view_index_is_not_dummy(1);
  assert_view_message_at_indices(smsg, 0, 1);

  // we used to display total in tag column - make sure we don't do that.
  if (gDBView.cellTextForColumn(0, "tags") != "") {
    view_throw("tag column shouldn't display total count in group view");
  }

  // - move the messages to the trash
  await messageInjection.trashMessages(synSet);

  // - make sure the message and dummy disappear
  assert_view_empty();

  // - add two messages from this week (same date bucket concerns)
  const [newer, newerSet] = await make_and_add_message({
    age: { days: 2, hours: 1 },
  });
  const [older] = await make_and_add_message({ age: { days: 2, hours: 2 } });

  // - sanity check addition
  assert_view_row_count(3); // 2 messages + 1 dummy
  assert_view_index_is_dummy(0);
  assert_view_index_is_not_dummy(1, 2);
  // the dummy should be based off the older guy
  assert_view_message_at_indices(older, 0, 1);
  assert_view_message_at_indices(newer, 2);

  // - delete the message right under the dummy
  // (this will be the newer one)
  await messageInjection.trashMessages(newerSet);

  // - ensure we still have the dummy and the right child node
  assert_view_row_count(2);
  assert_view_index_is_dummy(0);
  assert_view_index_is_not_dummy(1);
  // now the dummy should be based off the remaining older one
  assert_view_message_at_indices(older, 0, 1);
}

async function test_xfvf_threading() {
  // - start with an empty folder
  const save_gTestFolder = gTestFolder;
  gTestFolder = await messageInjection.makeEmptyFolder();

  let messages = [];
  // Add messages such that ancestors arrive after their descendants in
  // various interesting ways.
  // build a hierarchy like this (the UID order corresponds to the date order)
  //   3
  //    1
  //     4
  //      2
  //     5
  const msg3 = gMessageGenerator.makeMessage({ age: { days: 2, hours: 5 } });
  const msg1 = gMessageGenerator.makeMessage({
    age: { days: 2, hours: 4 },
    inReplyTo: msg3,
  });
  const msg4 = gMessageGenerator.makeMessage({
    age: { days: 2, hours: 3 },
    inReplyTo: msg1,
  });
  const msg2 = gMessageGenerator.makeMessage({
    age: { days: 2, hours: 1 },
    inReplyTo: msg4,
  });
  const msg5 = gMessageGenerator.makeMessage({
    age: { days: 2, hours: 2 },
    inReplyTo: msg1,
  });
  messages = messages.concat([msg1, msg2, msg3, msg4, msg5]);

  const msgSet = new SyntheticMessageSet(messages);

  gTestFolder = await messageInjection.makeEmptyFolder();

  // - create the view
  await messageInjection.addSetsToFolders([gTestFolder], [msgSet]);
  setup_view("xfvf", Ci.nsMsgViewFlagsType.kThreadedDisplay);
  assert_view_row_count(5);
  gDBView.toggleOpenState(0);
  gDBView.toggleOpenState(0);

  assert_view_message_at_indices(msg3, 0);
  assert_view_message_at_indices(msg1, 1);
  assert_view_message_at_indices(msg4, 2);
  assert_view_message_at_indices(msg2, 3);
  assert_view_message_at_indices(msg5, 4);
  assert_view_level_is(0, 0);
  assert_view_level_is(1, 1);
  assert_view_level_is(2, 2);
  assert_view_level_is(3, 3);
  assert_view_level_is(4, 2);
  gTestFolder = save_gTestFolder;
}

/*
 * Tests the sorting order of collapsed threads, not of messages within
 * threads. Currently limited to testing the sort-threads-by-date case,
 * sorting both by thread root and by newest message.
 */
async function test_thread_sorting() {
  const save_gTestFolder = gTestFolder;
  gTestFolder = await messageInjection.makeEmptyFolder();
  let messages = [];
  // build a hierarchy like this (the UID order corresponds to the date order)
  //  1
  //   4 (read)
  //  2 (read)
  //   5
  //  3
  //  6 (read)
  const msg1 = gMessageGenerator.makeMessage({ age: { days: 1, hours: 10 } });
  const msg2 = gMessageGenerator.makeMessage({
    age: { days: 1, hours: 9 },
    read: true,
  });
  const msg3 = gMessageGenerator.makeMessage({ age: { days: 1, hours: 8 } });
  const msg4 = gMessageGenerator.makeMessage({
    age: { days: 1, hours: 7 },
    inReplyTo: msg1,
    read: true,
  });
  const msg5 = gMessageGenerator.makeMessage({
    age: { days: 1, hours: 6 },
    inReplyTo: msg2,
  });
  const msg6 = gMessageGenerator.makeMessage({
    age: { days: 1, hours: 5 },
    read: true,
  });
  messages = messages.concat([msg1, msg2, msg3, msg4, msg5, msg6]);

  const msgSet = new SyntheticMessageSet(messages);

  await messageInjection.addSetsToFolders([gTestFolder], [msgSet]);

  // test the non-default pref state first, so the pref gets left with its
  // default value at the end
  Services.prefs.setBoolPref("mailnews.sort_threads_by_root", true);
  gDBView.open(
    gTestFolder,
    Ci.nsMsgViewSortType.byDate,
    Ci.nsMsgViewSortOrder.ascending,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    {}
  );

  assert_view_row_count(4);
  assert_view_message_at_indices(msg1, 0);
  assert_view_message_at_indices(msg2, 1);
  assert_view_message_at_indices(msg3, 2);
  assert_view_message_at_indices(msg6, 3);

  gDBView.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending);
  assert_view_message_at_indices(msg6, 0);
  assert_view_message_at_indices(msg3, 1);
  assert_view_message_at_indices(msg2, 2);
  assert_view_message_at_indices(msg1, 3);

  gDBView.sort(Ci.nsMsgViewSortType.byUnread, Ci.nsMsgViewSortOrder.ascending);
  assert_view_message_at_indices(msg6, 0);
  assert_view_message_at_indices(msg2, 1);
  assert_view_message_at_indices(msg3, 2);
  assert_view_message_at_indices(msg1, 3);

  gDBView.sort(Ci.nsMsgViewSortType.byUnread, Ci.nsMsgViewSortOrder.descending);
  assert_view_message_at_indices(msg3, 0);
  assert_view_message_at_indices(msg1, 1);
  assert_view_message_at_indices(msg6, 2);
  assert_view_message_at_indices(msg2, 3);

  Services.prefs.clearUserPref("mailnews.sort_threads_by_root");
  gDBView.open(
    gTestFolder,
    Ci.nsMsgViewSortType.byDate,
    Ci.nsMsgViewSortOrder.ascending,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    {}
  );

  assert_view_row_count(4);
  assert_view_message_at_indices(msg3, 0);
  assert_view_message_at_indices(msg1, 1);
  assert_view_message_at_indices(msg2, 2);
  assert_view_message_at_indices(msg6, 3);

  gDBView.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending);
  assert_view_message_at_indices(msg6, 0);
  assert_view_message_at_indices(msg2, 1);
  assert_view_message_at_indices(msg1, 2);
  assert_view_message_at_indices(msg3, 3);

  gDBView.sort(Ci.nsMsgViewSortType.byUnread, Ci.nsMsgViewSortOrder.ascending);
  assert_view_message_at_indices(msg6, 0);
  assert_view_message_at_indices(msg2, 1);
  assert_view_message_at_indices(msg1, 2);
  assert_view_message_at_indices(msg3, 3);

  gDBView.sort(Ci.nsMsgViewSortType.byUnread, Ci.nsMsgViewSortOrder.descending);
  assert_view_message_at_indices(msg2, 0);
  assert_view_message_at_indices(msg1, 1);
  assert_view_message_at_indices(msg3, 2);
  assert_view_message_at_indices(msg6, 3);

  gDBView.close();
  gTestFolder = save_gTestFolder;
}

const VIEW_TYPES = [
  ["threaded", Ci.nsMsgViewFlagsType.kThreadedDisplay],
  ["quicksearch", Ci.nsMsgViewFlagsType.kThreadedDisplay],
  ["search", Ci.nsMsgViewFlagsType.kThreadedDisplay],
  ["search", Ci.nsMsgViewFlagsType.kGroupBySort],
  ["xfvf", Ci.nsMsgViewFlagsType.kNone],
  // group does unspeakable things to gTestFolder, so put it last.
  ["group", Ci.nsMsgViewFlagsType.kGroupBySort],
];

/**
 * These are tests which are for every test configuration.
 */
function tests_for_all_views() {
  test_sort_columns();
  test_number_of_messages();
  test_selected_messages();
}

add_task(async function test_threaded() {
  await set_gTestFolder();
  const [view_type, view_flag] = VIEW_TYPES[0];
  setup_view(view_type, view_flag);

  tests_for_all_views();

  // Specific tests for threaded.
  test_expand_collapse();
  await test_thread_sorting();
});

add_task(async function test_quicksearchCopiedThreadMembers() {
  const messages = setup_messages();
  await set_gTestFolder(messages);
  const sourceFolder = gTestFolder;
  const sourceKeys = new Set(
    [...sourceFolder.messages].map(hdr => hdr.messageKey)
  );
  await set_gTestFolder(messages);
  const headers = [...gTestFolder.messages];
  const expected = headers.map(physicalIdentity);
  const parents = headers.map(hdr => [
    hdr.messageKey,
    hdr.threadId,
    hdr.threadParent,
  ]);
  Assert.equal(
    expected.length,
    39,
    "The copied folder contains all physical messages"
  );
  Assert.notEqual(sourceFolder.URI, gTestFolder.URI);
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const isNative =
    "nsIDatabaseCore" in Ci && service instanceof Ci.nsIDatabaseCore;
  if (isNative) {
    Assert.ok(
      headers.some(hdr => sourceKeys.has(hdr.threadParent)),
      "Native copies retain physical parents in the original folder"
    );
  }

  setup_view("quicksearch", Ci.nsMsgViewFlagsType.kThreadedDisplay);
  test_number_of_messages();
  const actual = Array.from({ length: gTreeView.rowCount }, (_, index) =>
    physicalIdentity(gDBView.getMsgHdrAt(index))
  );
  const compare = (left, right) => left[1] - right[1];
  Assert.deepEqual(
    actual.sort(compare),
    expected.sort(compare),
    "The view includes each copied physical message once and excludes the source folder"
  );
  test_selected_messages();
  if (isNative) {
    Assert.deepEqual(
      [...gTestFolder.messages].map(hdr => [
        hdr.messageKey,
        hdr.threadId,
        hdr.threadParent,
      ]),
      parents,
      "Displaying copied threads does not rewrite native parents or thread IDs"
    );
  }
});

add_task(async function test_quicksearch_threaded() {
  await set_gTestFolder();
  const [view_type, view_flag] = VIEW_TYPES[1];
  setup_view(view_type, view_flag);

  tests_for_all_views();

  // Specific tests for quicksearch threaded.
  test_qs_results();
});

add_task(async function test_search_threaded() {
  await set_gTestFolder();
  const [view_type, view_flag] = VIEW_TYPES[2];
  setup_view(view_type, view_flag);

  tests_for_all_views();

  // Specific tests for search threaded.
  await test_msg_added_to_search_view();
});

add_task(async function test_search_group_by_sort() {
  await set_gTestFolder();
  const [view_type, view_flag] = VIEW_TYPES[3];
  setup_view(view_type, view_flag);

  tests_for_all_views();

  // Specific tests for search group by sort.
  await test_msg_added_to_search_view();
});

add_task(async function test_xfvf() {
  await set_gTestFolder();
  const [view_type, view_flag] = VIEW_TYPES[4];
  setup_view(view_type, view_flag);

  tests_for_all_views();

  // Specific tests for xfvf.
  await test_xfvf_threading();
});

add_task(async function test_group() {
  await set_gTestFolder();
  const [view_type, view_flag] = VIEW_TYPES[5];
  setup_view(view_type, view_flag);

  tests_for_all_views();

  // Specific tests for group.
  await test_group_sort_collapseAll_expandAll_threading();
  await test_group_dummies_under_mutation_by_date();
});

add_task(async function test_threadDateSortReadErrorPreservesView() {
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  if (!("nsIDatabaseCore" in Ci) || !(service instanceof Ci.nsIDatabaseCore)) {
    info("Native SQLite error control; the original eight cases cover Mork");
    return;
  }
  const core = service.QueryInterface(Ci.nsIDatabaseCore);
  const pref = "mailnews.sort_threads_by_root";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref);
  const parent = gMessageGenerator.makeMessage({
    subject: "thread-date-error-parent",
    age: { days: 3 },
  });
  const child = gMessageGenerator.makeMessage({
    inReplyTo: parent,
    age: { days: 2 },
  });
  const other = gMessageGenerator.makeMessage({
    subject: "thread-date-error-other",
    age: { days: 1 },
  });
  const connection = core.connectionForTests;
  let renamed = false;
  try {
    Services.prefs.setBoolPref(pref, false);
    await set_gTestFolder(new SyntheticMessageSet([parent, other, child]));
    for (const viewType of ["threaded", "quicksearch"]) {
      setup_view(viewType, Ci.nsMsgViewFlagsType.kThreadedDisplay);
      Assert.equal(gDBView.rowCount, 3);
      const first = gDBView.getMsgHdrAt(0);
      const thread = gTestFolder.msgDatabase.getThreadContainingMsgHdr(first);
      Assert.equal(thread.numChildren, 2);
      const newest = thread.newestMsgDate;
      Assert.greater(newest, first.dateInSeconds);
      gFakeSelection.rangedSelect(0, 1, false);
      gFakeSelection.clearRange(0, 0);
      const physical = header => [
        header.folder.URI,
        header.messageKey,
        header.messageId,
      ];
      const capture = () => ({
        rows: Array.from({ length: gDBView.rowCount }, (_, index) => ({
          identity: physical(gDBView.getMsgHdrAt(index)),
          level: gTreeView.getLevel(index),
        })),
        selected: gDBView.getSelectedMsgHdrs().map(physical),
        current: gFakeSelection.currentIndex,
        pivot: gFakeSelection.shiftSelectPivot,
        sortType: gDBView.sortType,
        sortOrder: gDBView.sortOrder,
        viewFlags: gDBView.viewFlags,
      });
      const before = capture();
      for (const sortType of [
        Ci.nsMsgViewSortType.byDate,
        Ci.nsMsgViewSortType.byReceived,
      ]) {
        // Prime the existing view header cache before making the date query fail.
        gDBView.getMsgHdrAt(0);
        connection.executeSimpleSQL(
          "ALTER TABLE messages RENAME TO unavailable_view_dates"
        );
        renamed = true;
        try {
          Assert.throws(
            () => thread.newestMsgDate,
            error => error.result == Cr.NS_ERROR_FAILURE,
            "The actual native thread-date query fails"
          );
          Assert.throws(
            () => gDBView.sort(sortType, Ci.nsMsgViewSortOrder.descending),
            error => error.result == Cr.NS_ERROR_FAILURE,
            "The original date query error reaches the public view sort"
          );
        } finally {
          connection.executeSimpleSQL(
            "ALTER TABLE unavailable_view_dates RENAME TO messages"
          );
          renamed = false;
        }
        Assert.deepEqual(
          capture(),
          before,
          "A failed sort preserves every physical row, level and selection"
        );
        Assert.equal(thread.newestMsgDate, newest);
      }
      gDBView.sort(
        Ci.nsMsgViewSortType.byDate,
        Ci.nsMsgViewSortOrder.descending
      );
      Assert.equal(
        gDBView.rowCount,
        3,
        "Sorting recovers after the real storage error"
      );
      Assert.deepEqual(
        gDBView.getSelectedMsgHdrs().map(physical),
        before.selected
      );
      Assert.deepEqual(
        physical(gDBView.getMsgHdrAt(gFakeSelection.shiftSelectPivot)),
        before.rows[before.pivot].identity,
        "The unselected physical anchor survives a successful sort too"
      );
    }
  } finally {
    if (renamed) {
      connection.executeSimpleSQL(
        "ALTER TABLE unavailable_view_dates RENAME TO messages"
      );
    }
    if (hadPref) {
      Services.prefs.setBoolPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  }
});

add_task(async function test_flatSortReadErrorRestoresSelection() {
  const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  if (!("nsIDatabaseCore" in Ci) || !(service instanceof Ci.nsIDatabaseCore)) {
    info("Native SQLite error control; original cases retain Mork coverage");
    return;
  }
  await set_gTestFolder(
    new SyntheticMessageSet(gMessageGenerator.makeMessages({ count: 3 }))
  );
  setup_view("threaded", Ci.nsMsgViewFlagsType.kNone);
  const connection = service.QueryInterface(
    Ci.nsIDatabaseCore
  ).connectionForTests;
  const physical = header => [
    header.folder.URI,
    header.messageKey,
    header.messageId,
  ];
  const capture = () => ({
    rows: Array.from({ length: gDBView.rowCount }, (_, index) =>
      physical(gDBView.getMsgHdrAt(index))
    ),
    selected: gDBView.getSelectedMsgHdrs().map(physical),
    current: gFakeSelection.currentIndex,
    pivot: gFakeSelection.shiftSelectPivot,
    sortType: gDBView.sortType,
    sortOrder: gDBView.sortOrder,
  });
  for (const sortType of [
    Ci.nsMsgViewSortType.byDate,
    Ci.nsMsgViewSortType.byReceived,
  ]) {
    gDBView.sort(Ci.nsMsgViewSortType.byId, Ci.nsMsgViewSortOrder.ascending);
    gFakeSelection.rangedSelect(0, 1, false);
    gFakeSelection.clearRange(0, 0);
    const before = capture();
    Assert.equal(gFakeSelection.selectEventsSuppressed, false);
    connection.executeSimpleSQL(
      "ALTER TABLE messages RENAME TO unavailable_flat_sort"
    );
    try {
      Assert.throws(
        () => gDBView.sort(sortType, Ci.nsMsgViewSortOrder.descending),
        error => error.result == Cr.NS_ERROR_FAILURE,
        "The original numeric field read failure is returned"
      );
      Assert.equal(
        gFakeSelection.selectEventsSuppressed,
        false,
        "Failed flat sorting unfreezes selection events"
      );
    } finally {
      connection.executeSimpleSQL(
        "ALTER TABLE unavailable_flat_sort RENAME TO messages"
      );
    }
    Assert.deepEqual(
      capture(),
      before,
      "The physical selection/current/anchor and rows survive"
    );
  }
  const selected = gDBView.getSelectedMsgHdrs().map(physical);
  gDBView.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending);
  Assert.equal(gFakeSelection.selectEventsSuppressed, false);
  Assert.deepEqual(gDBView.getSelectedMsgHdrs().map(physical), selected);
});

/**
 * A failed thread read keeps its committed physical prefix and original error.
 */
add_task(async function test_threadReadStopsAtOriginalWriteError() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    info(
      "Native-only SQLite fault control; the existing ordinary Mork cases remain unchanged"
    );
    return;
  }
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(
    core instanceof Ci.nsIDatabaseCore,
    "The requested native backend is active"
  );
  const parent = gMessageGenerator.makeMessage({
    subject: "selected-read-parent",
  });
  const child = gMessageGenerator.makeMessage({ inReplyTo: parent });
  const control = gMessageGenerator.makeMessage({ subject: "read-control" });
  const set = new SyntheticMessageSet([parent, child, control]);
  await set_gTestFolder(set);
  const expectedStore = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Assert.ok(
    expectedStore == "@mozilla.org/msgstore/berkeleystore;1" ||
      expectedStore == "@mozilla.org/msgstore/maildirstore;1",
    "The ordinary input independently declares a supported physical store"
  );
  Assert.equal(
    Services.prefs.getCharPref("mail.server.default.storeContractID"),
    expectedStore,
    "Both startup store inputs agree"
  );
  Assert.equal(
    gTestFolder.server.getStringValue("storeContractID"),
    expectedStore,
    "The actual physical store matches the independently declared input"
  );
  const [root, reply, untouched] = set.msgHdrList;
  const otherFolder = await messageInjection.makeEmptyFolder();
  const copies = new SyntheticMessageSet([parent, child]);
  await messageInjection.addSetsToFolders([otherFolder], [copies]);
  const physical = header => [header.folder.URI, header.messageKey];
  const otherBefore = copies.msgHdrList.map(header => [
    physical(header),
    header.flags,
  ]);
  const db = gTestFolder.msgDatabase;
  root.flags = Ci.nsMsgMessageFlags.Marked;
  reply.flags = 0;
  db.addToNewList(root.messageKey);
  db.addToNewList(reply.messageKey);
  Assert.equal(
    root.flags,
    Ci.nsMsgMessageFlags.Marked | Ci.nsMsgMessageFlags.New
  );
  Assert.equal(reply.flags, Ci.nsMsgMessageFlags.New);
  const controlBefore = untouched.flags;
  setup_view(
    "threaded",
    Ci.nsMsgViewFlagsType.kThreadedDisplay | Ci.nsMsgViewFlagsType.kShowIgnored
  );
  const rootIndex = gDBView.findIndexOfMsgHdr(root, true);
  gFakeSelection.select(rootIndex);
  const thread = db.getThreadContainingMsgHdr(root);
  Assert.deepEqual(
    Array.from({ length: thread.numChildren }, (_, i) =>
      physical(thread.getChildHdrAt(i))
    ),
    [physical(root), physical(reply)],
    "The real completed fixture supplies the selected ordered physical thread"
  );
  const connection = core.connectionForTests;
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_selected_thread_read BEFORE UPDATE OF flags ON messages
     WHEN OLD.id = ${reply.messageKey}
     BEGIN SELECT RAISE(ABORT, 'selected thread write failure'); END`
  );
  try {
    Assert.throws(
      () => gDBView.doCommand(Ci.nsMsgViewCommandType.markThreadRead),
      error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT,
      "The public thread command returns the actual later write failure"
    );
    Assert.ok(root.isRead, "The earlier successful write remains committed");
    Assert.equal(
      root.flags,
      Ci.nsMsgMessageFlags.Marked | Ci.nsMsgMessageFlags.Read
    );
    Assert.ok(!reply.isRead, "The failed member is not reported as read");
    Assert.equal(reply.flags, Ci.nsMsgMessageFlags.New);
    Assert.deepEqual(gDBView.getSelectedMsgHdrs().map(physical), [
      physical(root),
    ]);
    Assert.equal(untouched.flags, controlBefore);
    Assert.deepEqual(
      copies.msgHdrList.map(header => [physical(header), header.flags]),
      otherBefore,
      "Equal Message-ID copies in another folder are unchanged"
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_selected_thread_read");
  }
  gDBView.doCommand(Ci.nsMsgViewCommandType.markThreadRead);
  Assert.ok(
    root.isRead && reply.isRead,
    "The same operation recovers normally"
  );
  Assert.equal(reply.flags, Ci.nsMsgMessageFlags.Read);
  gDBView.doCommand(Ci.nsMsgViewCommandType.selectThread);
  Assert.deepEqual(gDBView.getSelectedMsgHdrs().map(physical), [
    physical(root),
    physical(reply),
  ]);
  gDBView.doCommand(Ci.nsMsgViewCommandType.markMessagesUnread);
  Assert.ok(
    !root.isRead && !reply.isRead,
    "The selected thread becomes unread"
  );
  Assert.equal(root.flags, Ci.nsMsgMessageFlags.Marked);
  Assert.equal(reply.flags, 0, "Unread does not recreate the cleared NewList");
  Assert.equal(untouched.flags, controlBefore);
  Assert.deepEqual(
    copies.msgHdrList.map(header => [physical(header), header.flags]),
    otherBefore
  );
  gDBView.close();
});

/**
 * Watch/ignore errors leave row state truthful, and success survives reopen.
 */
add_task(async function test_watchedIgnoredErrorsAndReopen() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    info(
      "Native-only SQLite fault control; the existing ordinary Mork cases remain unchanged"
    );
    return;
  }
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(
    core instanceof Ci.nsIDatabaseCore,
    "The requested native backend is active"
  );
  const parent = gMessageGenerator.makeMessage({ subject: "watched-parent" });
  const child = gMessageGenerator.makeMessage({ inReplyTo: parent });
  const control = gMessageGenerator.makeMessage({ subject: "watched-control" });
  const set = new SyntheticMessageSet([parent, child, control]);
  await set_gTestFolder(set);
  const [root, reply, untouched] = set.msgHdrList;
  const key = root.messageKey;
  const preservedFlags = 0x80000000;
  gTestFolder.msgDatabase.getThreadContainingMsgHdr(root).flags =
    preservedFlags;
  const physical = header => [header.folder.URI, header.messageKey];
  setup_view(
    "threaded",
    Ci.nsMsgViewFlagsType.kThreadedDisplay | Ci.nsMsgViewFlagsType.kShowIgnored
  );
  gFakeSelection.select(gDBView.findIndexOfMsgHdr(root, true));
  const before = Array.from({ length: gDBView.rowCount }, (_, i) =>
    physical(gDBView.getMsgHdrAt(i))
  );
  const connection = core.connectionForTests;
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_selected_thread_state BEFORE INSERT ON thread_flags
     BEGIN SELECT RAISE(ABORT, 'selected thread state failure'); END`
  );
  try {
    Assert.throws(
      () => gDBView.doCommand(Ci.nsMsgViewCommandType.toggleThreadWatched),
      error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.throws(
      () =>
        gDBView.viewNavigate(
          Ci.nsMsgNavigationType.toggleThreadKilled,
          {},
          {},
          {},
          false
        ),
      error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT,
      "Ignore returns its original write failure without navigating away"
    );
    Assert.deepEqual(
      Array.from({ length: gDBView.rowCount }, (_, i) =>
        physical(gDBView.getMsgHdrAt(i))
      ),
      before,
      "A failed thread-state write does not collapse or replace rows"
    );
    Assert.deepEqual(gDBView.getSelectedMsgHdrs().map(physical), [
      physical(root),
    ]);
    Assert.equal(
      gTestFolder.msgDatabase.getThreadContainingMsgHdr(root).flags,
      preservedFlags
    );
    Assert.ok(
      root.isRead && reply.isRead,
      "Ignore's completed read prefix stays committed"
    );
    Assert.ok(!untouched.isRead);
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_selected_thread_state");
  }
  gDBView.doCommand(Ci.nsMsgViewCommandType.toggleThreadWatched);
  Assert.equal(
    gTestFolder.msgDatabase.getThreadContainingMsgHdr(root).flags,
    (preservedFlags | Ci.nsMsgMessageFlags.Watched) >>> 0
  );
  gDBView.close();
  gTestFolder.ForceDBClosed();
  let db = gTestFolder.msgDatabase;
  let reopened = db.getMsgHdrForKey(key);
  Assert.equal(
    db.getThreadContainingMsgHdr(reopened).flags,
    (preservedFlags | Ci.nsMsgMessageFlags.Watched) >>> 0
  );
  setup_view(
    "threaded",
    Ci.nsMsgViewFlagsType.kThreadedDisplay | Ci.nsMsgViewFlagsType.kShowIgnored
  );
  gFakeSelection.select(gDBView.findIndexOfMsgHdr(reopened, true));
  gDBView.viewNavigate(
    Ci.nsMsgNavigationType.toggleThreadKilled,
    {},
    {},
    {},
    false
  );
  Assert.equal(
    db.getThreadContainingMsgHdr(reopened).flags,
    (preservedFlags | Ci.nsMsgMessageFlags.Ignored) >>> 0
  );
  gDBView.close();
  gTestFolder.ForceDBClosed();
  db = gTestFolder.msgDatabase;
  reopened = db.getMsgHdrForKey(key);
  Assert.equal(
    db.getThreadContainingMsgHdr(reopened).flags,
    (preservedFlags | Ci.nsMsgMessageFlags.Ignored) >>> 0
  );
  Assert.equal(
    db.getThreadContainingMsgHdr(db.getMsgHdrForKey(untouched.messageKey))
      .flags,
    0,
    "The other physical thread remains unchanged across reopen"
  );
});

/**
 * Killed descendants and a failed read keep the exact selected physical branch.
 */
add_task(async function test_killedBranchErrorsAndReopen() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    info(
      "Native-only SQLite fault control; the existing ordinary Mork cases remain unchanged"
    );
    return;
  }
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(
    core instanceof Ci.nsIDatabaseCore,
    "The requested native backend is active"
  );
  const rootMessage = gMessageGenerator.makeMessage({ subject: "killed-root" });
  const branchMessage = gMessageGenerator.makeMessage({
    inReplyTo: rootMessage,
  });
  const leafMessage = gMessageGenerator.makeMessage({
    inReplyTo: branchMessage,
  });
  const siblingMessage = gMessageGenerator.makeMessage({
    inReplyTo: rootMessage,
  });
  const set = new SyntheticMessageSet([
    rootMessage,
    branchMessage,
    leafMessage,
    siblingMessage,
  ]);
  await set_gTestFolder(set);
  const [root, branch, leaf, sibling] = set.msgHdrList;
  const otherFolder = await messageInjection.makeEmptyFolder();
  const copies = new SyntheticMessageSet([branchMessage, leafMessage]);
  await messageInjection.addSetsToFolders([otherFolder], [copies]);
  const otherBefore = copies.msgHdrList.map(header => header.flags);
  const db = gTestFolder.msgDatabase;
  db.markKilled(sibling.messageKey, true, null);
  Assert.ok(!sibling.isRead, "The preexisting killed sibling starts unread");
  setup_view(
    "threaded",
    Ci.nsMsgViewFlagsType.kThreadedDisplay | Ci.nsMsgViewFlagsType.kShowIgnored
  );
  gFakeSelection.select(gDBView.findIndexOfMsgHdr(branch, true));
  const connection = core.connectionForTests;
  connection.executeSimpleSQL(
    `CREATE TEMP TRIGGER reject_selected_descendant BEFORE UPDATE OF flags ON messages
     WHEN OLD.id = ${leaf.messageKey} AND (NEW.flags & 1) != 0
     BEGIN SELECT RAISE(ABORT, 'selected descendant read failure'); END`
  );
  try {
    Assert.throws(
      () =>
        gDBView.viewNavigate(
          Ci.nsMsgNavigationType.toggleSubthreadKilled,
          {},
          {},
          {},
          false
        ),
      error => error.result === Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.ok(
      branch.isKilled,
      "The successful selected marker remains committed"
    );
    Assert.ok(
      branch.isRead,
      "The completed selected read prefix remains committed"
    );
    Assert.ok(!leaf.isRead, "The failed descendant stays unread");
    Assert.ok(
      !root.isRead && !sibling.isRead,
      "Root and sibling are outside the selected branch"
    );
    Assert.deepEqual(
      gDBView.getSelectedMsgHdrs().map(header => header.messageKey),
      [branch.messageKey]
    );
    Assert.deepEqual(
      copies.msgHdrList.map(header => header.flags),
      otherBefore
    );
  } finally {
    connection.executeSimpleSQL("DROP TRIGGER reject_selected_descendant");
  }
  // Undo only the selected marker, then retry the same real command normally.
  gDBView.viewNavigate(
    Ci.nsMsgNavigationType.toggleSubthreadKilled,
    {},
    {},
    {},
    false
  );
  Assert.ok(!branch.isKilled);
  gDBView.viewNavigate(
    Ci.nsMsgNavigationType.toggleSubthreadKilled,
    {},
    {},
    {},
    false
  );
  Assert.ok(branch.isKilled && leaf.isKilled);
  Assert.ok(branch.isRead && leaf.isRead);
  Assert.ok(
    !root.isRead && !sibling.isRead,
    "An already killed sibling is not marked read"
  );
  const keys = set.msgHdrList.map(header => header.messageKey);
  gDBView.close();
  gTestFolder.ForceDBClosed();
  const reopened = keys.map(key =>
    gTestFolder.msgDatabase.getMsgHdrForKey(key)
  );
  Assert.deepEqual(
    reopened.map(header => header.isKilled),
    [false, true, true, true]
  );
  Assert.deepEqual(
    reopened.map(header => header.isRead),
    [false, true, true, false]
  );
  Assert.deepEqual(
    copies.msgHdrList.map(header => header.flags),
    otherBefore
  );
  gTestFolder.msgDatabase.markKilled(branch.messageKey, false, null);
  setup_view(
    "threaded",
    Ci.nsMsgViewFlagsType.kThreadedDisplay | Ci.nsMsgViewFlagsType.kShowIgnored
  );
  gFakeSelection.select(gDBView.findIndexOfMsgHdr(reopened[1], true));
  const beforeCycle = reopened.map(header => header.flags);
  let savedParent;
  const parentStatement = connection.createStatement(
    "SELECT threadParent FROM messages WHERE id = :key"
  );
  try {
    parentStatement.params.key = root.messageKey;
    Assert.ok(parentStatement.executeStep());
    savedParent = parentStatement.row.threadParent;
  } finally {
    parentStatement.finalize();
  }
  // A corrupt stored cycle cannot be produced by the checked normal callers.
  // This critical failure control changes only the parent word and restores it
  // before normal teardown, just as the existing storage-error controls do.
  connection.executeSimpleSQL(
    `UPDATE messages SET threadParent = ${leaf.messageKey} WHERE id = ${root.messageKey}`
  );
  try {
    Assert.throws(
      () =>
        gDBView.viewNavigate(
          Ci.nsMsgNavigationType.toggleSubthreadKilled,
          {},
          {},
          {},
          false
        ),
      error => error.result === Cr.NS_ERROR_FILE_CORRUPTED,
      "The native cycle error reaches the selected retained operation"
    );
    Assert.deepEqual(
      reopened.map(header => header.flags),
      beforeCycle,
      "A rejected physical cycle does not write a killed marker or read prefix"
    );
  } finally {
    connection.executeSimpleSQL(
      `UPDATE messages SET threadParent = ${savedParent === null ? "NULL" : savedParent} WHERE id = ${root.messageKey}`
    );
  }
  gDBView.close();
});

/**
 * Forward a stored header while replacing specific getters for date faults.
 *
 * @param {nsIMsgDBHdr} header - The real physical fixture header.
 * @param {object} getters - Test getters keyed by their attribute names.
 * @returns {nsIMsgDBHdr} The forwarding scriptable header.
 */
function threadDateHeader(header, getters) {
  return new Proxy(
    { QueryInterface: ChromeUtils.generateQI(["nsIMsgDBHdr"]) },
    {
      get(target, property) {
        if (property === "QueryInterface") {
          return target.QueryInterface;
        }
        if (Object.hasOwn(getters, property)) {
          return getters[property]();
        }
        const value = header[property];
        return typeof value === "function" ? value.bind(header) : value;
      },
    }
  );
}

add_task(async function test_searchThreadDateErrorPreservesVisibleOrder() {
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(core instanceof Ci.nsIDatabaseCore);
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled", false));
  const pref = "mailnews.sort_threads_by_root";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref);
  const physical = header => [header.folder.URI, header.messageKey];
  const capture = () => ({
    rows: Array.from({ length: gDBView.rowCount }, (_, i) => [
      physical(gDBView.getMsgHdrAt(i)),
      gTreeView.getLevel(i),
      gDBView.getFlagsAt(i),
    ]),
    selected: gDBView.getSelectedMsgHdrs().map(physical),
    current: gFakeSelection.currentIndex,
    pivot: gFakeSelection.shiftSelectPivot,
    suppressed: gFakeSelection.selectEventsSuppressed,
    sortType: gDBView.sortType,
    sortOrder: gDBView.sortOrder,
  });
  try {
    Services.prefs.setBoolPref(pref, false);
    for (const sortType of [
      Ci.nsMsgViewSortType.byDate,
      Ci.nsMsgViewSortType.byReceived,
    ]) {
      for (const zeroDates of [false, true]) {
        const parent = gMessageGenerator.makeMessage({ age: { days: 3 } });
        const child = gMessageGenerator.makeMessage({
          inReplyTo: parent,
          age: { days: 2 },
        });
        const control = gMessageGenerator.makeMessage({ age: { days: 1 } });
        const initial = new SyntheticMessageSet([parent, child, control]);
        await set_gTestFolder(initial);
        const [root, oldChild, outside] = initial.msgHdrList;
        Assert.equal(
          gTestFolder.server.getStringValue("storeContractID"),
          "@mozilla.org/msgstore/berkeleystore;1"
        );
        if (zeroDates) {
          root.date = 0;
          oldChild.date = 0;
        }
        setup_view("search", Ci.nsMsgViewFlagsType.kThreadedDisplay);
        gDBView.sort(sortType, Ci.nsMsgViewSortOrder.descending);
        const incomingSet = new SyntheticMessageSet([
          gMessageGenerator.makeMessage({
            inReplyTo: parent,
            age: { days: 0 },
          }),
        ]);
        await messageInjection.addSetsToFolders([gTestFolder], [incomingSet]);
        const [incoming] = incomingSet.msgHdrList;
        if (zeroDates) {
          incoming.date = 0;
        } else {
          Assert.greater(
            incoming.dateInSeconds,
            outside.dateInSeconds,
            "The real incoming fixture is newer than the outside thread"
          );
        }
        gFakeSelection.select(gDBView.findIndexOfMsgHdr(oldChild, true));
        const before = capture();
        Assert.deepEqual(
          before.rows.map(row => row[0]),
          [outside, root, oldChild].map(physical)
        );
        const notify = gDBView.QueryInterface(Ci.nsIMsgSearchNotify);
        if (!zeroDates) {
          let reads = 0;
          const forwarded = threadDateHeader(incoming, {
            dateInSeconds() {
              if (++reads === 3) {
                throw Components.Exception(
                  "Late search date read",
                  Cr.NS_ERROR_ILLEGAL_VALUE
                );
              }
              return incoming.dateInSeconds;
            },
          });
          Assert.throws(
            () => notify.onSearchHit(forwarded, gTestFolder),
            error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE,
            "The late caller returns the original date error"
          );
          Assert.equal(reads, 3, "Both earlier XF AddHdr date reads succeeded");
          Assert.deepEqual(
            capture(),
            before,
            "No visible mutation after failure"
          );
          const thread = gDBView.getThreadContainingMsgHdr(root);
          Assert.equal(
            thread.numChildren,
            3,
            "The earlier XF member prefix stays"
          );
          Assert.deepEqual(
            Array.from({ length: thread.numChildren }, (_, i) =>
              physical(thread.getChildHdrAt(i))
            ),
            [root, oldChild, incoming].map(physical)
          );
          Assert.equal(thread.newestMsgDate, incoming.dateInSeconds);
          Assert.equal(
            gDBView.getThreadContainingMsgHdr(incoming).threadKey,
            thread.threadKey,
            "The earlier hash association stays too"
          );

          // Rebuild from known physical inputs, not by replaying into the prefix.
          gDBView.close();
          gDBView = Cc[
            "@mozilla.org/messenger/msgdbview;1?type=search"
          ].createInstance(Ci.nsIMsgDBView);
          gDBView.init(null, null);
          gDBView.open(
            null,
            sortType,
            Ci.nsMsgViewSortOrder.descending,
            Ci.nsMsgViewFlagsType.kThreadedDisplay |
              Ci.nsMsgViewFlagsType.kExpandAll
          );
          gTreeView = gDBView.QueryInterface(Ci.nsITreeView);
          gTreeView.selection = gFakeSelection;
          gFakeSelection.view = gTreeView;
          gFakeSelection.clearSelection();
          const rebuilt = gDBView.QueryInterface(Ci.nsIMsgSearchNotify);
          rebuilt.onNewSearch();
          for (const header of [root, oldChild, outside]) {
            rebuilt.onSearchHit(header, gTestFolder);
          }
          rebuilt.onSearchDone(Cr.NS_OK);
          gDBView.sort(sortType, Ci.nsMsgViewSortOrder.descending);
        }
        gFakeSelection.select(gDBView.findIndexOfMsgHdr(oldChild, true));
        const selected = gDBView.getSelectedMsgHdrs().map(physical);
        gDBView
          .QueryInterface(Ci.nsIMsgSearchNotify)
          .onSearchHit(incoming, gTestFolder);
        Assert.deepEqual(
          capture().rows.map(row => row[0]),
          (zeroDates
            ? [outside, root, oldChild, incoming]
            : [root, oldChild, incoming, outside]
          ).map(physical),
          "Successful dates keep the exact physical thread order"
        );
        Assert.deepEqual(gDBView.getSelectedMsgHdrs().map(physical), selected);
        Assert.equal(
          gDBView.getThreadContainingMsgHdr(root).newestMsgDate,
          zeroDates ? 0 : incoming.dateInSeconds,
          "Zero is a successful newest date"
        );
        Assert.equal(gDBView.getThreadContainingMsgHdr(outside).numChildren, 1);
        gDBView.close();
      }
    }
  } finally {
    gDBView.close();
    if (hadPref) {
      Services.prefs.setBoolPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  }
});

add_task(async function test_newHeaderDateErrorPreservesView() {
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(core instanceof Ci.nsIDatabaseCore);
  Assert.ok(Services.prefs.getBoolPref("mail.panorama.enabled", false));
  const connection = core.connectionForTests;
  const pref = "mailnews.sort_threads_by_root";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref);
  const physical = header => [header.folder.URI, header.messageKey];
  const capture = () => ({
    rows: Array.from({ length: gDBView.rowCount }, (_, i) => [
      physical(gDBView.getMsgHdrAt(i)),
      gTreeView.getLevel(i),
      gDBView.getFlagsAt(i),
    ]),
    selected: gDBView.getSelectedMsgHdrs().map(physical),
    current: gFakeSelection.currentIndex,
    pivot: gFakeSelection.shiftSelectPivot,
    suppressed: gFakeSelection.selectEventsSuppressed,
  });
  try {
    Services.prefs.setBoolPref(pref, false);
    for (const sortType of [
      Ci.nsMsgViewSortType.byDate,
      Ci.nsMsgViewSortType.byReceived,
    ]) {
      for (const zeroDates of [false, true]) {
        const parent = gMessageGenerator.makeMessage({ age: { days: 3 } });
        const child = gMessageGenerator.makeMessage({
          inReplyTo: parent,
          age: { days: 2 },
        });
        const control = gMessageGenerator.makeMessage({ age: { days: 1 } });
        const initial = new SyntheticMessageSet([parent, child, control]);
        await set_gTestFolder(initial);
        const [root, oldChild, outside] = initial.msgHdrList;
        Assert.equal(
          gTestFolder.server.getStringValue("storeContractID"),
          "@mozilla.org/msgstore/berkeleystore;1"
        );
        if (zeroDates) {
          root.date = 0;
          oldChild.date = 0;
        }
        setup_view("threaded", Ci.nsMsgViewFlagsType.kThreadedDisplay);
        gDBView.sort(sortType, Ci.nsMsgViewSortOrder.descending);
        const db = gTestFolder.msgDatabase;
        const listener = gDBView.QueryInterface(Ci.nsIDBChangeListener);
        db.removeListener(listener);
        const incomingSet = new SyntheticMessageSet([
          gMessageGenerator.makeMessage({
            inReplyTo: parent,
            age: { days: 0 },
          }),
        ]);
        await messageInjection.addSetsToFolders([gTestFolder], [incomingSet]);
        const [incoming] = incomingSet.msgHdrList;
        if (zeroDates) {
          incoming.date = 0;
        } else {
          Assert.greater(
            incoming.dateInSeconds,
            outside.dateInSeconds,
            "The real incoming fixture is newer than the outside thread"
          );
        }
        gFakeSelection.select(gDBView.findIndexOfMsgHdr(oldChild, true));
        const before = capture();
        Assert.deepEqual(
          before.rows.map(row => row[0]),
          [outside, root, oldChild].map(physical)
        );
        if (!zeroDates) {
          let keyReads = 0;
          let dateReads = 0;
          let armedReads = 0;
          let armed = false;
          const forwarded = threadDateHeader(incoming, {
            messageKey() {
              // The second forwarded key read starts the final native lookup.
              armed = ++keyReads === 2;
              return incoming.messageKey;
            },
            dateInSeconds() {
              dateReads++;
              throw Components.Exception(
                "Later incoming date error",
                Cr.NS_ERROR_ILLEGAL_VALUE
              );
            },
          });
          const columns = [];
          const schema = connection.createStatement(
            "PRAGMA main.table_info(messages)"
          );
          try {
            while (schema.executeStep()) {
              const name = schema.getUTF8String(1);
              columns.push(
                name === "date"
                  ? "view_newest_date_fault(date) AS date"
                  : `"${name}"`
              );
            }
          } finally {
            schema.finalize();
          }
          connection.createFunction("view_newest_date_fault", 1, {
            onFunctionCall(args) {
              // GetMsgHdrForKey and CaptureMessage read the physical member
              // before the third date evaluation in GetThreadMaxDate.
              if (armed && ++armedReads === 3) {
                throw Components.Exception(
                  "Newest date SQL error",
                  Cr.NS_ERROR_FAILURE
                );
              }
              return args.getInt64(0);
            },
          });
          try {
            connection.executeSimpleSQL(
              `CREATE TEMP VIEW messages AS SELECT ${columns.join(", ")} FROM main.messages`
            );
            Assert.throws(
              () => listener.onHdrAdded(forwarded, root.messageKey, 0, null),
              error => error.result === Cr.NS_ERROR_FAILURE,
              "The original newest-date error wins before the later header read"
            );
            Assert.equal(keyReads, 2, "The final physical lookup was reached");
            Assert.equal(
              armedReads,
              3,
              "Two physical reads precede the failed max read"
            );
            Assert.equal(
              dateReads,
              0,
              "The later date getter was never called"
            );
          } finally {
            try {
              connection.executeSimpleSQL("DROP VIEW IF EXISTS temp.messages");
            } finally {
              connection.removeFunction("view_newest_date_fault");
            }
          }
          Assert.deepEqual(
            capture(),
            before,
            "The newest error preserves the view"
          );
          armed = false;
          Assert.throws(
            () => listener.onHdrAdded(forwarded, root.messageKey, 0, null),
            error => error.result === Cr.NS_ERROR_ILLEGAL_VALUE,
            "A successful newest read exposes the distinct later header error"
          );
          Assert.equal(dateReads, 1);
          Assert.deepEqual(
            capture(),
            before,
            "The later date error preserves the view"
          );
        }
        listener.onHdrAdded(incoming, root.messageKey, 0, null);
        Assert.deepEqual(
          capture().rows.map(row => row[0]),
          (zeroDates
            ? [outside, root, oldChild, incoming]
            : [root, oldChild, incoming, outside]
          ).map(physical),
          "The same real physical delivery recovers with no duplicate rows"
        );
        Assert.deepEqual(
          gDBView.getSelectedMsgHdrs().map(physical),
          before.selected
        );
        Assert.equal(gFakeSelection.selectEventsSuppressed, before.suppressed);
        const thread = db.getThreadContainingMsgHdr(root);
        Assert.equal(
          thread.newestMsgDate,
          zeroDates ? 0 : incoming.dateInSeconds
        );
        Assert.deepEqual(
          Array.from({ length: thread.numChildren }, (_, i) =>
            physical(thread.getChildHdrAt(i))
          ),
          [root, oldChild, incoming].map(physical)
        );
        Assert.equal(db.getThreadContainingMsgHdr(outside).numChildren, 1);
        gDBView.close();
      }
    }
  } finally {
    gDBView.close();
    if (hadPref) {
      Services.prefs.setBoolPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  }
});

add_task(function test_teardown() {
  // Delete view reference to avoid a cycle leak.
  gFakeSelection.view = null;
});
