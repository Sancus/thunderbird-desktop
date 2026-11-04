/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test DBViewWrapper against virtual folders.
 *
 * Things we do not test and our rationalizations:
 * - threading stuff.  This is not the view wrapper's problem.  That is the db
 *   view's problem!  (We test it in the real folder to make sure we are telling
 *   it to do things correctly.)
 * - view flags.  Again, it's a db view issue once we're sure we set the bits.
 * - special view with threads.  same deal.
 *
 * We could test all these things, but my patch is way behind schedule...
 */

/* import-globals-from resources/viewWrapperTestUtils.js */
load("resources/viewWrapperTestUtils.js");
initViewWrapperTestUtils({ mode: "local" });

var { MessageGenerator, SyntheticMessageSet } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

// -- single-folder backed virtual folder

/**
 * Make sure we open a virtual folder backed by a single underlying folder
 *  correctly; no constraints.
 */
add_task(async function test_virtual_folder_single_load_no_pred() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne], setOne] = await messageInjection.makeFoldersWithSets(1, [
    {},
  ]);

  const virtFolder = messageInjection.makeVirtualFolder([folderOne], {});
  await view_open(viewWrapper, virtFolder);

  Assert.ok(viewWrapper.isVirtual);

  assert_equals(
    gMockViewWrapperListener.allMessagesLoadedEventCount,
    1,
    "Should only have received a single all messages loaded notification!"
  );

  verify_messages_in_view(setOne, viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Make sure we open a virtual folder backed by a single underlying folder
 *  correctly; one constraint.
 */
add_task(async function test_virtual_folder_single_load_simple_pred() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne], oneSubjFoo] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, {}]
  );

  const virtFolder = messageInjection.makeVirtualFolder([folderOne], {
    subject: "foo",
  });
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view(oneSubjFoo, viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Make sure we open a virtual folder backed by a single underlying folder
 *  correctly; two constraints ANDed together.
 */
add_task(async function test_virtual_folder_single_load_complex_pred() {
  const viewWrapper = make_view_wrapper();

  const whoBar = make_person_with_word_in_name("bar");

  const [[folderOne], , , oneBoth] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, { from: whoBar }, { subject: "foo", from: whoBar }, {}]
  );

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne],
    { subject: "foo", from: "bar" },
    /* and? */ true
  );
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view(oneBoth, viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Open a single-backed virtual folder, verify, open another single-backed
 *  virtual folder, verify.  We are testing our ability to change folders
 *  without exploding.
 */
add_task(async function test_virtual_folder_single_load_after_load() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne], oneSubjFoo] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, {}]
  );
  const virtOne = messageInjection.makeVirtualFolder([folderOne], {
    subject: "foo",
  });
  await view_open(viewWrapper, virtOne);
  verify_messages_in_view([oneSubjFoo], viewWrapper);

  // use "bar" instead of "foo" to make sure constraints are properly changing
  const [[folderTwo], twoSubjBar] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "bar" }, {}]
  );
  const virtTwo = messageInjection.makeVirtualFolder([folderTwo], {
    subject: "bar",
  });
  await view_open(viewWrapper, virtTwo);
  verify_messages_in_view([twoSubjBar], viewWrapper);
  virtOne.parent.propagateDelete(virtOne, true);
  virtTwo.parent.propagateDelete(virtTwo, true);
});

// -- multi-folder backed virtual folder

/**
 * Make sure we open a virtual folder backed by multiple underlying folders
 *  correctly; no constraints.
 */
add_task(async function test_virtual_folder_multi_load_no_pred() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne], setOne] = await messageInjection.makeFoldersWithSets(1, [
    {},
  ]);
  const [[folderTwo], setTwo] = await messageInjection.makeFoldersWithSets(1, [
    {},
  ]);

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view([setOne, setTwo], viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Make sure the sort order of a virtual folder backed by multiple underlying
 * folders is persistent.
 */
add_task(async function test_virtual_folder_multi_sortorder_persistence() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne], setOne] = await messageInjection.makeFoldersWithSets(1, [
    {},
  ]);
  const [[folderTwo], setTwo] = await messageInjection.makeFoldersWithSets(1, [
    {},
  ]);

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view([setOne, setTwo], viewWrapper);
  viewWrapper.showThreaded = true;
  viewWrapper.sort("subjectCol", Ci.nsMsgViewSortOrder.ascending);

  viewWrapper.close();
  await view_open(viewWrapper, virtFolder);
  assert_equals(
    viewWrapper.primarySortType,
    Ci.nsMsgViewSortType.bySubject,
    "should have remembered sort type."
  );
  assert_equals(
    viewWrapper.primarySortOrder,
    Ci.nsMsgViewSortOrder.ascending,
    "should have remembered sort order."
  );
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Verify that we handle implicit secondary sorts correctly for virtual folders.
 *
 * When we sort first by Y, then by X, we should implicitly use Y as the
 * secondary sort so long as that is valid.
 */
add_task(async function test_sort_secondary_implicit() {
  const viewWrapper = make_view_wrapper();

  const [folders, setOne] = await messageInjection.makeFoldersWithSets(2, [
    { count: 10 },
  ]);
  const virtFolder = messageInjection.makeVirtualFolder(folders, {});
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view([setOne], viewWrapper);
  viewWrapper.showThreaded = true;

  viewWrapper.sort("subjectCol", Ci.nsMsgViewSortOrder.descending);
  viewWrapper.sort("senderCol", Ci.nsMsgViewSortOrder.ascending);

  const checkSorts = () => {
    assert_equals(
      viewWrapper.dbView.sortType,
      Ci.nsMsgViewSortType.byAuthor,
      "sort should be by author"
    );
    assert_equals(
      viewWrapper.dbView.sortOrder,
      Ci.nsMsgViewSortOrder.ascending,
      "sort order should be ascending"
    );
    assert_equals(
      viewWrapper.dbView.secondarySortType,
      Ci.nsMsgViewSortType.bySubject,
      "secondary sort should be by subject"
    );
    assert_equals(
      viewWrapper.dbView.secondarySortOrder,
      Ci.nsMsgViewSortOrder.descending,
      "secondary sort order should be descending"
    );
  };

  // Verify that the correct columns are used for primary and secondary sort.
  // We verify again after refreshing the view to ensure that the setting is
  // persistent.
  checkSorts();
  await view_refresh(viewWrapper);
  checkSorts();
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Make sure the sort order of a virtual folder backed by multiple underlying
 * folders is set correctly even when no messages are present.
 */
add_task(async function test_virtual_folder_multi_sortorder_when_empty() {
  const viewWrapper = make_view_wrapper();

  const folderOne = await messageInjection.makeEmptyFolder();
  const folderTwo = await messageInjection.makeEmptyFolder();

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );
  await view_open(viewWrapper, virtFolder);

  verify_empty_view(viewWrapper);
  viewWrapper.showThreaded = true;
  viewWrapper.sort("subjectCol", Ci.nsMsgViewSortOrder.ascending);

  viewWrapper.close();
  await view_open(viewWrapper, virtFolder);
  assert_equals(
    viewWrapper.primarySortType,
    Ci.nsMsgViewSortType.bySubject,
    "should have remembered sort type."
  );
  assert_equals(
    viewWrapper.primarySortOrder,
    Ci.nsMsgViewSortOrder.ascending,
    "should have remembered sort order."
  );
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Make sure we open a virtual folder backed by multiple underlying folders
 *  correctly; one constraint.
 */
add_task(async function test_virtual_folder_multi_load_simple_pred() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne], oneSubjFoo] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, {}]
  );
  const [[folderTwo], twoSubjFoo] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, {}]
  );

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {
      subject: "foo",
    }
  );
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view([oneSubjFoo, twoSubjFoo], viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/**
 * Make sure we open a virtual folder backed by multiple underlying folders
 *  correctly; two constraints ANDed together.
 */
add_task(async function test_virtual_folder_multi_load_complex_pred() {
  const viewWrapper = make_view_wrapper();

  const whoBar = make_person_with_word_in_name("bar");

  const [[folderOne], , , oneBoth] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, { from: whoBar }, { subject: "foo", from: whoBar }, {}]
  );
  const [[folderTwo], , , twoBoth] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, { from: whoBar }, { subject: "foo", from: whoBar }, {}]
  );

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    { subject: "foo", from: "bar" },
    /* and? */ true
  );
  await view_open(viewWrapper, virtFolder);

  verify_messages_in_view([oneBoth, twoBoth], viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

add_task(
  async function test_virtual_folder_multi_load_alotta_folders_no_pred() {
    const viewWrapper = make_view_wrapper();

    const folderCount = 4;
    const messageCount = 64;

    const [folders, setOne] = await messageInjection.makeFoldersWithSets(
      folderCount,
      [{ count: messageCount }]
    );

    const virtFolder = messageInjection.makeVirtualFolder(folders, {});
    await view_open(viewWrapper, virtFolder);

    verify_messages_in_view([setOne], viewWrapper);
    virtFolder.parent.propagateDelete(virtFolder, true);
  }
);

add_task(
  async function test_virtual_folder_multi_load_alotta_folders_simple_pred() {
    const viewWrapper = make_view_wrapper();

    const folderCount = 16;
    const messageCount = 256;

    const [folders, setOne] = await messageInjection.makeFoldersWithSets(
      folderCount,
      [{ subject: "foo", count: messageCount }]
    );

    const virtFolder = messageInjection.makeVirtualFolder(folders, {
      subject: "foo",
    });
    await view_open(viewWrapper, virtFolder);

    verify_messages_in_view([setOne], viewWrapper);
    virtFolder.parent.propagateDelete(virtFolder, true);
  }
);

/**
 * Make sure that opening a virtual folder backed by multiple real folders, then
 *  opening another virtual folder of the same variety works without explosions.
 */
add_task(async function test_virtual_folder_multi_load_after_load() {
  const viewWrapper = make_view_wrapper();

  const [foldersOne, oneSubjFoo] = await messageInjection.makeFoldersWithSets(
    2,
    [{ subject: "foo" }, {}]
  );
  const virtOne = messageInjection.makeVirtualFolder(foldersOne, {
    subject: "foo",
  });
  await view_open(viewWrapper, virtOne);
  verify_messages_in_view([oneSubjFoo], viewWrapper);

  // use "bar" instead of "foo" to make sure constraints are properly changing
  const [foldersTwo, twoSubjBar] = await messageInjection.makeFoldersWithSets(
    3,
    [{ subject: "bar" }, {}]
  );
  const virtTwo = messageInjection.makeVirtualFolder(foldersTwo, {
    subject: "bar",
  });
  await view_open(viewWrapper, virtTwo);
  verify_messages_in_view([twoSubjBar], viewWrapper);

  await view_open(viewWrapper, virtOne);
  verify_messages_in_view([oneSubjFoo], viewWrapper);
  virtOne.parent.propagateDelete(virtOne, true);
  virtTwo.parent.propagateDelete(virtTwo, true);
});

// -- mixture of single-backed and multi-backed

/**
 * Make sure that opening a virtual folder backed by a single real folder, then
 *  a multi-backed one, then the single-backed one again doesn't explode.
 *
 * This is just test_virtual_folder_multi_load_after_load with foldersOne told
 *  to create just a single folder.
 */
add_task(async function test_virtual_folder_combo_load_after_load() {
  const viewWrapper = make_view_wrapper();

  const [foldersOne, oneSubjFoo] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, {}]
  );
  const virtOne = messageInjection.makeVirtualFolder(foldersOne, {
    subject: "foo",
  });
  await view_open(viewWrapper, virtOne);
  verify_messages_in_view([oneSubjFoo], viewWrapper);

  // use "bar" instead of "foo" to make sure constraints are properly changing
  const [foldersTwo, twoSubjBar] = await messageInjection.makeFoldersWithSets(
    3,
    [{ subject: "bar" }, {}]
  );
  const virtTwo = messageInjection.makeVirtualFolder(foldersTwo, {
    subject: "bar",
  });
  await view_open(viewWrapper, virtTwo);
  verify_messages_in_view([twoSubjBar], viewWrapper);

  await view_open(viewWrapper, virtOne);
  verify_messages_in_view([oneSubjFoo], viewWrapper);
  virtOne.parent.propagateDelete(virtOne, true);
  virtTwo.parent.propagateDelete(virtTwo, true);
});

// -- ignore things we should ignore

/**
 * Make sure that if a server is listed in a virtual folder's search Uris that
 *  it does not get into our list of _underlyingFolders.
 */
add_task(async function test_virtual_folder_filters_out_servers() {
  const viewWrapper = make_view_wrapper();

  const [folders] = await messageInjection.makeFoldersWithSets(2, []);
  folders.push(folders[0].rootFolder);
  const virtFolder = messageInjection.makeVirtualFolder(folders, {});
  await view_open(viewWrapper, virtFolder);

  assert_equals(
    viewWrapper._underlyingFolders.length,
    2,
    "Server folder should have been filtered out."
  );
  virtFolder.parent.propagateDelete(virtFolder, true);
});

// -- rare/edge cases!

/**
 * Verify that if one of the folders backing our virtual folder is deleted that
 *  we do not explode.  Then verify that if we remove the rest of them that the
 *  view wrapper closes itself.
 */
add_task(async function test_virtual_folder_underlying_folder_deleted() {
  const viewWrapper = make_view_wrapper();

  const [[folderOne]] = await messageInjection.makeFoldersWithSets(1, [
    { subject: "foo" },
    {},
  ]);
  const [[folderTwo], twoSubjFoo] = await messageInjection.makeFoldersWithSets(
    1,
    [{ subject: "foo" }, {}]
  );

  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {
      subject: "foo",
    }
  );
  await view_open(viewWrapper, virtFolder);

  // this triggers the search (under the view's hood), so it's async
  await delete_folder(folderOne, viewWrapper);

  // only messages from the surviving folder should be present
  verify_messages_in_view([twoSubjFoo], viewWrapper);

  // this one is not async though, because we are expecting to close the wrapper
  //  and ignore the view entirely, no resolving action.
  delete_folder(folderTwo);

  // now the view wrapper should have closed itself.
  Assert.equal(null, viewWrapper.displayedFolder);
  // This fails because virtFolder.parent is null, not sure why
  // virtFolder.parent.propagateDelete(virtFolder, true);
});

/* ===== Virtual Folder, Mail Views ===== */

/*
 * We do not need to test all of the mail view permutations, realFolder
 *  already did that.  We just need to make sure it works at all.
 */

add_task(
  async function test_virtual_folder_mail_views_unread_with_one_folder() {
    const viewWrapper = make_view_wrapper();

    const [folders, fooOne, fooTwo] =
      await messageInjection.makeFoldersWithSets(1, [
        { subject: "foo 1" },
        { subject: "foo 2" },
        {},
        {},
      ]);
    const virtFolder = messageInjection.makeVirtualFolder(folders, {
      subject: "foo",
    });

    // everything is unread to start with!
    await view_open(viewWrapper, virtFolder);
    await view_set_mail_view(viewWrapper, MailViewConstants.kViewItemUnread);
    verify_messages_in_view([fooOne, fooTwo], viewWrapper);

    // add some more things (unread!), make sure they appear.
    const [fooThree] = await messageInjection.makeNewSetsInFolders(folders, [
      { subject: "foo 3" },
      {},
    ]);
    verify_messages_in_view([fooOne, fooTwo, fooThree], viewWrapper);

    // make some things read, make sure they disappear. (after a refresh)
    fooTwo.setRead(true);
    await view_refresh(viewWrapper);
    verify_messages_in_view([fooOne, fooThree], viewWrapper);

    // make those things un-read again.
    fooTwo.setRead(false);
    // I thought this was a quick search limitation, but XFVF needs it to, at
    //  least for the unread case.
    await view_refresh(viewWrapper);
    verify_messages_in_view([fooOne, fooTwo, fooThree], viewWrapper);
    virtFolder.parent.propagateDelete(virtFolder, true);
  }
);

// -- mail views

add_task(
  async function test_virtual_folder_mail_views_unread_with_four_folders() {
    const viewWrapper = make_view_wrapper();

    const [folders, fooOne, fooTwo] =
      await messageInjection.makeFoldersWithSets(4, [
        { subject: "foo 1" },
        { subject: "foo 2" },
        {},
        {},
      ]);
    const virtFolder = messageInjection.makeVirtualFolder(folders, {
      subject: "foo",
    });

    // everything is unread to start with!
    await view_open(viewWrapper, virtFolder);
    await view_set_mail_view(viewWrapper, MailViewConstants.kViewItemUnread);
    verify_messages_in_view([fooOne, fooTwo], viewWrapper);

    // add some more things (unread!), make sure they appear.
    const [fooThree] = await messageInjection.makeNewSetsInFolders(folders, [
      { subject: "foo 3" },
      {},
    ]);
    verify_messages_in_view([fooOne, fooTwo, fooThree], viewWrapper);

    // make some things read, make sure they disappear. (after a refresh)
    fooTwo.setRead(true);
    await view_refresh(viewWrapper);
    verify_messages_in_view([fooOne, fooThree], viewWrapper);

    // make those things un-read again.
    fooTwo.setRead(false);
    // I thought this was a quick search limitation, but XFVF needs it to, at
    //  least for the unread case.
    await view_refresh(viewWrapper);
    verify_messages_in_view([fooOne, fooTwo, fooThree], viewWrapper);
    virtFolder.parent.propagateDelete(virtFolder, true);
  }
);

// This tests that clearing the new messages in a folder also clears the
// new flag on saved search folders based on the real folder. This could be a
// core view test, or a mozmill test, but I think the view wrapper stuff
// is involved in some of the issues here, so this is a compromise.
add_task(async function test_virtual_folder_mail_new_handling() {
  const viewWrapper = make_view_wrapper();

  const [folders] = await messageInjection.makeFoldersWithSets(1, [
    { subject: "foo 1" },
    { subject: "foo 2" },
  ]);
  const folder = folders[0];
  const virtFolder = messageInjection.makeVirtualFolder(folders, {
    subject: "foo",
  });

  await view_open(viewWrapper, folder);

  await messageInjection.makeNewSetsInFolders(folders, [
    { subject: "foo 3" },
    {},
  ]);

  if (!virtFolder.hasNewMessages) {
    do_throw("saved search should have new messages!");
  }

  if (!folder.hasNewMessages) {
    do_throw("folder should have new messages!");
  }

  viewWrapper.close();
  folder.msgDatabase = null;
  folder.clearNewMessages();
  if (virtFolder.hasNewMessages) {
    do_throw("saved search should not have new messages!");
  }
  virtFolder.parent.propagateDelete(virtFolder, true);
});

/* ===== Virtual Folder, Threading Modes ==== */
/*
 * The first three tests that verify setting the threading flags has the
 *  expected outcome do this by creating the view from scratch with the view
 *  flags applied.  The view threading persistence test handles making sure
 *  that changes in threading on-the-fly work from the perspective of the
 *  bits and what not.  None of these are tests of the view implementation's
 *  threading/grouping logic, just sanity checking that we are doing the right
 *  thing.
 */

add_task(async function test_virtual_folder_threading_unthreaded() {
  const viewWrapper = make_view_wrapper();
  // Create two maximally nested threads and spread them across the underlying
  // folders.
  const count = 10;
  const setThreadOne = new SyntheticMessageSet(
    gMessageScenarioFactory.directReply(count)
  );
  const setThreadTwo = new SyntheticMessageSet(
    gMessageScenarioFactory.directReply(count)
  );
  const folderOne = await messageInjection.makeEmptyFolder();
  const folderTwo = await messageInjection.makeEmptyFolder();
  await messageInjection.addSetsToFolders(
    [folderOne, folderTwo],
    [setThreadOne, setThreadTwo]
  );
  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );
  await view_open(viewWrapper, virtFolder);

  // verify that we are not threaded (or grouped)
  viewWrapper.beginViewUpdate();
  viewWrapper.showUnthreaded = true;
  // whitebox test view flags (we've gotten them wrong before...)
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should not be set."
  );
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should not be set."
  );
  viewWrapper.endViewUpdate();
  verify_messages_in_view([setThreadOne, setThreadTwo], viewWrapper);
  verify_view_level_histogram({ 0: count * 2 }, viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

add_task(async function test_virtual_folder_threading_threaded() {
  const viewWrapper = make_view_wrapper();
  // Create two maximally nested threads and spread them across the underlying
  // folders.
  const count = 10;
  const setThreadOne = new SyntheticMessageSet(
    gMessageScenarioFactory.directReply(count)
  );
  const setThreadTwo = new SyntheticMessageSet(
    gMessageScenarioFactory.directReply(count)
  );
  const folderOne = await messageInjection.makeEmptyFolder();
  const folderTwo = await messageInjection.makeEmptyFolder();
  await messageInjection.addSetsToFolders(
    [folderOne, folderTwo],
    [setThreadOne, setThreadTwo]
  );
  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );
  await view_open(viewWrapper, virtFolder);

  // verify that we are threaded (in such a way that we can't be grouped)
  viewWrapper.beginViewUpdate();
  viewWrapper.showThreaded = true;
  // whitebox test view flags (we've gotten them wrong before...)
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should be set."
  );
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should not be set."
  );
  // expand everything so our logic below works.
  view_expand_all(viewWrapper);
  viewWrapper.endViewUpdate();
  verify_messages_in_view([setThreadOne, setThreadTwo], viewWrapper);
  // blackbox test view flags: make sure IsContainer is true for the root
  verify_view_row_at_index_is_container(viewWrapper, 0);
  verify_view_row_at_index_is_container(viewWrapper, 10);
  // do the histogram test to verify threading...
  const expectedHisto = {};
  for (let i = 0; i < count; i++) {
    expectedHisto[i] = 2;
  }
  verify_view_level_histogram(expectedHisto, viewWrapper);
  virtFolder.parent.propagateDelete(virtFolder, true);
});

add_task(async function test_virtual_folder_threading_grouped_by_sort() {
  const viewWrapper = make_view_wrapper();
  // Create messages that belong to the 'Last 7 Days' as well as the
  // 'Older' bucket when sorting by date and grouping by date.
  const count = 10;
  const setOne = new SyntheticMessageSet(
    new MessageGenerator().makeMessages({
      count,
      age: { days: 2 },
      age_incr: { mins: 1 },
    })
  );
  const setTwo = new SyntheticMessageSet(
    new MessageGenerator().makeMessages({
      count,
      age: { days: 30 },
      age_incr: { mins: 1 },
    })
  );
  const folderOne = await messageInjection.makeEmptyFolder();
  const folderTwo = await messageInjection.makeEmptyFolder();
  await messageInjection.addSetsToFolders(
    [folderOne, folderTwo],
    [setOne, setTwo]
  );
  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );
  await view_open(viewWrapper, virtFolder);

  // Grouped by sort sorted by date.
  viewWrapper.beginViewUpdate();
  viewWrapper.showGroupedBySort = true;
  // whitebox test view flags (we've gotten them wrong before...)
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should be set."
  );
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should be set."
  );
  viewWrapper.sort("dateCol", Ci.nsMsgViewSortOrder.ascending);
  viewWrapper.endViewUpdate();

  // Make sure the level depths are correct ...
  verify_view_level_histogram({ 0: 2 }, viewWrapper);
  // ... and make sure the both rows are dummies.
  verify_view_row_at_index_is_dummy(viewWrapper, 0);
  verify_view_row_at_index_is_dummy(viewWrapper, 1);
});

/**
 * Verify that we the threading modes are persisted.  We are only checking
 *  flags here; we trust the previous tests to have done their job.
 */
add_task(async function test_virtual_folder_threading_persistence() {
  const viewWrapper = make_view_wrapper();
  // Create two maximally nested threads and spread them across the underlying
  // folders.
  const count = 10;
  const setThreadOne = new SyntheticMessageSet(
    gMessageScenarioFactory.directReply(count)
  );
  const setThreadTwo = new SyntheticMessageSet(
    gMessageScenarioFactory.directReply(count)
  );
  const folderOne = await messageInjection.makeEmptyFolder();
  const folderTwo = await messageInjection.makeEmptyFolder();
  await messageInjection.addSetsToFolders(
    [folderOne, folderTwo],
    [setThreadOne, setThreadTwo]
  );
  const virtFolder = messageInjection.makeVirtualFolder(
    [folderOne, folderTwo],
    {}
  );

  // open the folder, set threaded mode, close it
  await view_open(viewWrapper, virtFolder);
  viewWrapper.showThreaded = true; // should be instantaneous
  verify_view_row_at_index_is_container(viewWrapper, 0);
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should be set."
  );
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should not be set."
  );
  viewWrapper.close();

  // open it again, make sure we're threaded, go unthreaded, close
  viewWrapper.open(virtFolder);
  assert_true(viewWrapper.showThreaded, "view should be threaded");
  assert_false(viewWrapper.showUnthreaded, "view is lying about threading");
  assert_false(viewWrapper.showGroupedBySort, "view is lying about threading");
  verify_view_row_at_index_is_container(viewWrapper, 0);
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should be set."
  );
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should not be set."
  );

  viewWrapper.showUnthreaded = true;
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should not be set."
  );
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should not be set."
  );
  viewWrapper.close();

  // open it again, make sure we're unthreaded, go grouped, close
  viewWrapper.open(virtFolder);
  assert_true(viewWrapper.showUnthreaded, "view should be unthreaded");
  assert_false(viewWrapper.showThreaded, "view is lying about threading");
  assert_false(viewWrapper.showGroupedBySort, "view is lying about threading");
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should not be set."
  );
  assert_bit_not_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should not be set."
  );

  viewWrapper.showGroupedBySort = true;
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should be set."
  );
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should be set."
  );
  viewWrapper.close();

  // open it again, make sure we're grouped.
  viewWrapper.open(virtFolder);
  assert_true(viewWrapper.showGroupedBySort, "view should be grouped");
  assert_false(viewWrapper.showThreaded, "view is lying about threading");
  assert_false(viewWrapper.showUnthreaded, "view is lying about threading");
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kThreadedDisplay,
    "View threaded bit should be set."
  );
  assert_bit_set(
    viewWrapper._viewFlags,
    Ci.nsMsgViewFlagsType.kGroupBySort,
    "View group-by-sort bit should be set."
  );
});

/** @returns {nsIDatabaseCore|null} The current native service for these controls. */
function savedSearchCore() {
  if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
    info(
      "Native saved-search controls; the original cases retain Mork coverage"
    );
    return null;
  }
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  Assert.ok(
    core.connectionForTests.connectionReady,
    "The native database is open"
  );
  return core;
}

/**
 * Adds a real body-store message, retaining physical folder/key identity.
 *
 * @param {nsIMsgFolder} folder - The physical destination.
 * @param {string} id - Literal Message-ID, without brackets.
 * @param {string} [subject="scope-match"] - Subject used by the saved predicate.
 * @returns {nsIMsgDBHdr} The stored physical header.
 */
function addScopedMessage(folder, id, subject = "scope-match") {
  const expected = Services.prefs.getCharPref(
    "mail.server.default.storeContractID"
  );
  Assert.equal(folder.server.getStringValue("storeContractID"), expected);
  Assert.equal(
    folder.server.msgStore.storeType,
    expected.includes("maildirstore") ? "maildir" : "mbox",
    "Actual physical body store"
  );
  return folder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .addMessage(
      "From: scope@example.invalid\r\nTo: reader@example.invalid\r\n" +
        "Date: Tue, 1 Sep 2026 12:00:00 +0000\r\n" +
        `Message-ID: <${id}>\r\nSubject: ${subject}\r\n\r\nStored body.\r\n`
    );
}

/**
 * Reads complete physical cache identities using the ordinary DB interface.
 *
 * @param {nsIMsgFolder} receiver - The cache receiver, not a scope partition.
 * @param {nsIMsgFolder} saved - The saved folder owning the global hit list.
 * @returns {Array<[string, number]>} Sorted folder/key identities.
 */
function scopedCache(receiver, saved) {
  return Array.from(
    receiver.msgDatabase.getCachedHits(saved.URI) ?? [],
    header => [header.folder.URI, header.messageKey]
  ).sort((a, b) => a[1] - b[1]);
}

/**
 * Checks real visible rows without conflating equal Message-IDs.
 *
 * @param {DBViewWrapper} wrapper - The open saved-search view.
 * @param {nsIMsgDBHdr[]} headers - Exact physical members.
 */
function assertScopedRows(wrapper, headers) {
  Assert.equal(
    wrapper.dbView.numMsgsInView,
    headers.length,
    "Exact complete membership before expanding threads"
  );
  wrapper.dbView.doCommand(Ci.nsMsgViewCommandType.expandAll);
  const physical = header => [header.folder.URI, header.messageKey];
  Assert.deepEqual(
    Array.from({ length: wrapper.dbView.rowCount }, (_, i) =>
      physical(wrapper.dbView.getMsgHdrAt(i))
    ).sort((a, b) => a[1] - b[1]),
    headers.map(physical).sort((a, b) => a[1] - b[1])
  );
}

add_task(async function test_scopedCachePreservesOtherPhysicalSource() {
  if (!savedSearchCore()) {
    return;
  }
  const a = await messageInjection.makeEmptyFolder();
  const b = await messageInjection.makeEmptyFolder();
  const outside = await messageInjection.makeEmptyFolder();
  const first = addScopedMessage(a, "physical-copies@scope.invalid");
  const second = addScopedMessage(b, "physical-copies@scope.invalid");
  const foreign = addScopedMessage(outside, "physical-copies@scope.invalid");
  Assert.notEqual(
    first.messageKey,
    second.messageKey,
    "Real native keys are globally allocated"
  );
  const saved = messageInjection.makeVirtualFolder([a, b], {
    subject: "scope-match",
  });
  // A valid global facade cache can contain an old out-of-scope physical key.
  a.msgDatabase.refreshCache(
    saved.URI,
    [first.messageKey, second.messageKey, foreign.messageKey].sort(
      (x, y) => x - y
    )
  );
  const wrapper = make_view_wrapper();
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [first, second]);
  Assert.deepEqual(scopedCache(b, saved), [
    [a.URI, first.messageKey],
    [b.URI, second.messageKey],
  ]);
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [first, second]);
  wrapper.close();
  saved.parent.propagateDelete(saved, true);
});

add_task(async function test_emptySourceRefreshPreservesOtherHits() {
  if (!savedSearchCore()) {
    return;
  }
  const a = await messageInjection.makeEmptyFolder();
  const b = await messageInjection.makeEmptyFolder();
  const first = addScopedMessage(a, "empty-first@scope.invalid");
  const second = addScopedMessage(b, "empty-second@scope.invalid");
  const saved = messageInjection.makeVirtualFolder([a, b], {
    subject: "scope-match",
  });
  const wrapper = make_view_wrapper();
  await view_open(wrapper, saved);
  a.deleteMessages([first], null, true, false, null, false);
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [second]);
  Assert.deepEqual(
    scopedCache(a, saved),
    [[b.URI, second.messageKey]],
    "An empty first source preserves the second physical partition"
  );
  wrapper.close();
  saved.parent.propagateDelete(saved, true);
});

add_task(async function test_cacheReadErrorDoesNotPublishPartialSearch() {
  const core = savedSearchCore();
  if (!core) {
    return;
  }
  const a = await messageInjection.makeEmptyFolder();
  const b = await messageInjection.makeEmptyFolder();
  addScopedMessage(a, "enumerator-first@scope.invalid");
  addScopedMessage(b, "enumerator-second@scope.invalid");
  const saved = messageInjection.makeVirtualFolder([a, b], {
    subject: "scope-match",
  });
  const wrapper = make_view_wrapper();
  await view_open(wrapper, saved);
  const before = scopedCache(a, saved);
  const connection = core.connectionForTests;
  let calls = 0;
  connection.createFunction("s371_cache_read", 1, {
    onFunctionCall(args) {
      if (++calls == 2) {
        throw Components.Exception(
          "later saved-cache read",
          Cr.NS_ERROR_FAILURE
        );
      }
      return args.getInt64(0);
    },
  });
  try {
    connection.executeSimpleSQL(
      "CREATE TEMP VIEW search_folder_hits AS SELECT folder_id, s371_cache_read(message_id) AS message_id FROM main.search_folder_hits"
    );
    Assert.throws(
      () => wrapper.dbView.QueryInterface(Ci.nsIMsgSearchNotify).onNewSearch(),
      error => error.result == Cr.NS_ERROR_FAILURE,
      "A later real SQLite cached-hit read returns the original error"
    );
    Assert.greaterOrEqual(
      calls,
      2,
      "The first row was read before the later error"
    );
    Assert.equal(
      wrapper.dbView.rowCount,
      0,
      "No cached prefix is admitted as a successful source"
    );
  } finally {
    connection.executeSimpleSQL("DROP VIEW temp.search_folder_hits");
    connection.removeFunction("s371_cache_read");
  }
  Assert.deepEqual(
    scopedCache(a, saved),
    before,
    "A failed cached read did not replace the union"
  );
  await view_open(wrapper, saved);
  Assert.equal(
    wrapper.dbView.rowCount,
    2,
    "The normal search recovers after restoring storage"
  );
  wrapper.close();
  saved.parent.propagateDelete(saved, true);
});

add_task(
  async function test_savedSearchNotificationsTrackMatchingPhysicalMembers() {
    if (!savedSearchCore()) {
      return;
    }
    const a = await messageInjection.makeEmptyFolder();
    const b = await messageInjection.makeEmptyFolder();
    const outside = await messageInjection.makeEmptyFolder();
    const first = addScopedMessage(a, "notification-first@scope.invalid");
    const second = addScopedMessage(b, "notification-second@scope.invalid");
    const saved = messageInjection.makeVirtualFolder([a, b], {
      subject: "scope-match",
    });
    Assert.equal(
      saved.getTotalMessages(false),
      2,
      "Counts exist before the first view opens"
    );
    const wrapped = VirtualFolderHelper.wrapVirtualFolder(saved);
    wrapped.searchString =
      "AND (status,isn't,read) AND (subject,contains,scope-match)";
    const wrapper = make_view_wrapper();
    await view_open(wrapper, saved);
    first.markRead(true);
    assertScopedRows(wrapper, [second]);
    Assert.equal(saved.getTotalMessages(false), 1);
    Assert.equal(saved.getNumUnread(false), 1);
    first.markRead(false);
    assertScopedRows(wrapper, [first, second]);
    Assert.equal(
      saved.getTotalMessages(false),
      2,
      "The view and persistent binding do not double count"
    );
    const third = addScopedMessage(b, "notification-third@scope.invalid");
    addScopedMessage(outside, "notification-outside@scope.invalid");
    assertScopedRows(wrapper, [first, second, third]);
    b.deleteMessages([third], null, true, false, null, false);
    assertScopedRows(wrapper, [first, second]);
    Assert.equal(saved.getTotalMessages(false), 2);
    // Tags and flags can add/remove existing headers, not just invalidate rows.
    wrapped.searchString =
      "AND (status,is,flagged) AND (subject,contains,scope-match)";
    await view_open(wrapper, saved);
    assertScopedRows(wrapper, []);
    first.markFlagged(true);
    assertScopedRows(wrapper, [first]);
    first.markFlagged(false);
    assertScopedRows(wrapper, []);
    wrapper.close();
    wrapped.searchString = "AND (tag,contains,$label1)";
    a.addKeywordsToMessages([first], "$label1");
    Assert.equal(saved.getTotalMessages(false), 1);
    a.removeKeywordsFromMessages([first], "$label1");
    Assert.equal(saved.getTotalMessages(false), 0);
    saved.parent.propagateDelete(saved, true);
  }
);

add_task(async function test_savedSearchRebindDetachesOldScope() {
  if (!savedSearchCore()) {
    return;
  }
  const a = await messageInjection.makeEmptyFolder();
  const b = await messageInjection.makeEmptyFolder();
  const first = addScopedMessage(a, "rebind@scope.invalid");
  const second = addScopedMessage(b, "rebind@scope.invalid");
  const saved = messageInjection.makeVirtualFolder([a], {
    subject: "scope-match",
  });
  const wrapped = VirtualFolderHelper.wrapVirtualFolder(saved);
  wrapped.searchFolders = [b];
  addScopedMessage(a, "retired-source@scope.invalid");
  Assert.equal(saved.getTotalMessages(false), 1);
  Assert.deepEqual(scopedCache(b, saved), [[b.URI, second.messageKey]]);
  const wrapper = make_view_wrapper();
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [second]);
  Assert.notEqual(first.messageKey, second.messageKey);
  // Replacing the real source database detaches the old announcer and rebinds.
  const retired = b.msgDatabase;
  retired.forceClosed();
  const current = b.msgDatabase;
  Assert.notEqual(current, retired);
  const added = addScopedMessage(b, "replacement-db@scope.invalid");
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [second, added]);
  Assert.equal(saved.getTotalMessages(false), 2);
  wrapper.close();
  saved.parent.propagateDelete(saved, true);
});

add_task(async function test_savedSearchBindingSurvivesWrapperReopen() {
  if (!savedSearchCore()) {
    return;
  }
  const a = await messageInjection.makeEmptyFolder();
  const saved = messageInjection.makeVirtualFolder([a], {
    subject: "scope-match",
  });
  let ephemeral = VirtualFolderHelper.wrapVirtualFolder(saved);
  Assert.equal(ephemeral.virtualFolder, saved);
  ephemeral = null;
  const first = addScopedMessage(a, "unopened@scope.invalid");
  Assert.equal(
    saved.getTotalMessages(false),
    1,
    "The native factory retains an unopened search binding"
  );
  Assert.ok(
    saved.hasNewMessages,
    "New status propagates without a saved-search view"
  );
  const wrapper = make_view_wrapper();
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [first]);
  wrapper.close();
  a.clearNewMessages();
  Assert.ok(
    !saved.hasNewMessages,
    "Clearing the physical New list is synchronous"
  );
  const second = addScopedMessage(a, "after-close@scope.invalid");
  Assert.equal(saved.getTotalMessages(false), 2);
  Assert.ok(saved.hasNewMessages);
  await view_open(wrapper, saved);
  assertScopedRows(wrapper, [first, second]);
  wrapper.close();
  saved.parent.propagateDelete(saved, true);
});

add_task(async function test_savedSearchDetachRejectsLateNotification() {
  if (!savedSearchCore()) {
    return;
  }
  const a = await messageInjection.makeEmptyFolder();
  const saved = messageInjection.makeVirtualFolder([a], {
    subject: "scope-match",
  });
  const retained = VirtualFolderHelper.wrapVirtualFolder(saved);
  const wrapper = make_view_wrapper();
  await view_open(wrapper, saved);
  // Queues the native reconciliation, then removes its saved-folder identity.
  addScopedMessage(a, "before-delete@scope.invalid");
  saved.parent.propagateDelete(saved, true);
  Assert.equal(
    wrapper.displayedFolder,
    null,
    "Deletion closed the retained UI consumer"
  );
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  Assert.throws(
    () => retained.searchFolders,
    error => !Components.isSuccessCode(error.result),
    "A retired declaration cannot silently bind another or an empty folder"
  );
  addScopedMessage(a, "after-delete@scope.invalid");
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  Assert.equal(
    wrapper.displayedFolder,
    null,
    "Late native callbacks do not revive the closed consumer"
  );
});
