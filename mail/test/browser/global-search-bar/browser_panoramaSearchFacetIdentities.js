/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from head_panoramaSearchFacets.js */

// Use the same ordinary fixture for every bounded whole-file scenario.
Services.scriptloader.loadSubScript(
  new URL("head_panoramaSearchFacets.js", gTestPath).href,
  this
);

add_task(async function test_openFacetIdentityChangesRecomputeOwnAddresses() {
  const account = MailServices.accounts.createAccount();
  const identity = MailServices.accounts.createIdentity();
  identity.email = "openown@example.invalid";
  identity.replyTo = "Open Reply <openreply@example.invalid>";
  account.addIdentity(identity);
  let removed = false;
  const generator = fixture.generator;
  const term = "nativeopenidentityneedle";
  const raw = generator
    .makeMessage({
      subject: term,
      from: ["Own Sender", identity.email],
      to: [["Own Reply", "openreply@example.invalid"]],
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
        from: ["Identity Control", "identitycontrol@example.invalid"],
        to: [["Other Recipient", "otherrecipient@example.invalid"]],
      })
      .toMessageString()
  );
  const expected = headers.map(header => String(header.messageKey)).sort();
  let tab;
  try {
    const opened = await openNativeFacets(term);
    tab = opened.tab;
    const { context } = opened;
    const win = tab.browser.contentWindow;
    const fromMe = () =>
      context.faceters.find(faceter => faceter.field == "fromMe");
    const toMe = () =>
      context.faceters.find(faceter => faceter.field == "toMe");
    const assertCopies = () => {
      Assert.deepEqual(
        Array.from(context.activeSet, item => item.id).sort(),
        expected
      );
      Assert.ok(
        !context.activeSet.some(item => item.id == String(control.messageKey))
      );
      Assert.equal(context.fullSet.length, 3);
    };
    const tabs = tabmail.tabInfo.length;
    EventUtils.synthesizeMouseAtCenter(fromMe().xblNode.bubble, {}, win);
    assertCopies();
    identity.email = "changedown@example.invalid";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 0,
      "Actual email setter updates the already-open fromMe refinement"
    );
    await tab.searchPromise;
    Assert.ok(
      fromMe().constraint,
      "Empty current membership keeps the selected refinement"
    );
    Assert.ok(fromMe().xblNode.checked);
    identity.email = "openown@example.invalid";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 2
    );
    await tab.searchPromise;
    assertCopies();
    EventUtils.synthesizeMouseAtCenter(fromMe().xblNode.bubble, {}, win);
    Assert.equal(context.activeSet.length, 3);
    EventUtils.synthesizeMouseAtCenter(toMe().xblNode.bubble, {}, win);
    assertCopies();
    identity.replyTo = "Changed Reply <changedreply@example.invalid>";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 0,
      "Actual Reply-To setter updates current toMe membership"
    );
    await tab.searchPromise;
    Assert.ok(toMe().constraint);
    Assert.ok(toMe().xblNode.checked);
    identity.replyTo = "Open Reply <openreply@example.invalid>";
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 2
    );
    await tab.searchPromise;
    assertCopies();
    Assert.equal(
      tabmail.tabInfo.length,
      tabs,
      "Identity changes never open another query tab"
    );
    const people = context.faceters.find(
      faceter => faceter.field == "participants"
    );
    Assert.ok(
      !people.orderedGroups.some(([value]) =>
        ["openown@example.invalid", "openreply@example.invalid"].includes(
          value?.id
        )
      ),
      "Current own addresses are omitted from the people facet"
    );
    MailServices.accounts.removeAccount(account);
    removed = true;
    await TestUtils.waitForCondition(
      () => context.mailSearchResultSet && context.activeSet.length == 0,
      "Removing the real account updates the same retained own-address selection"
    );
    await tab.searchPromise;
    Assert.ok(toMe().constraint);
  } finally {
    if (tab) {
      tabmail.closeTab(tab);
    }
    if (!removed) {
      MailServices.accounts.removeAccount(account);
    }
  }
});
