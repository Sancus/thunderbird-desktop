/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  getMailSearchFacetData,
  refineMailSearchResults,
  getMailSearchOwnEmails,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchFacets.sys.mjs"
);

/**
 * Supplies literal physical members, including a copy and unknown metadata.
 *
 * @returns {MailSearchResultSet} Independent facet inputs.
 */
function facetFixture() {
  const definitions = [
    {
      id: "101",
      date: new Date("2020-01-01T00:00:00.000Z"),
      read: true,
      from: [{ email: "OWN@example.invalid" }],
      attachmentPresence: false,
    },
    {
      id: "102",
      date: new Date("2020-01-01T00:00:00.000Z"),
      starred: true,
      attachmentPresence: true,
      location: { folderId: 20, messageKey: 102 },
      to: [{ email: "own@example.invalid" }],
    },
    {
      id: "103",
      date: new Date("2020-01-02T00:00:00.000Z"),
      read: true,
      starred: true,
      cc: [{ email: "OWN@example.invalid" }],
    },
    {
      id: "104",
      date: new Date("2020-01-03T00:00:00.000Z"),
      attachmentPresence: false,
      bcc: [{ email: "own@example.invalid" }],
    },
    {
      id: "105",
      date: new Date("2019-01-01T00:00:00.000Z"),
      read: true,
      from: [{ email: "own@example.invalid" }],
    },
    {
      id: "106",
      date: new Date("2030-01-01T00:00:00.000Z"),
      read: undefined,
      attachmentPresence: true,
    },
    {
      id: "107",
      date: null,
      from: undefined,
      read: undefined,
      starred: undefined,
    },
    { id: "108", date: new Date(NaN) },
    { id: "109", date: new Date(0) },
  ];
  return {
    sourceId: "physical-core",
    resultSetId: "physical-query",
    items: definitions.map(definition => ({
      messageId: "shared@example.invalid",
      location: { folderId: 10, messageKey: Number(definition.id) },
      from: [{ email: "sender@example.invalid" }],
      to: [{ email: "recipient@example.invalid" }],
      cc: [],
      bcc: [],
      tagKeys: [],
      read: false,
      starred: false,
      hasAttachments: false,
      attachmentPresence: null,
      ...definition,
    })),
  };
}

add_task(function test_inclusiveDateRangesAndPhysicalCopies() {
  const full = facetFixture();
  const selected = refineMailSearchResults(full, {
    ownEmails: [],
    dateRanges: [
      [
        new Date("2020-01-01T00:00:00.000Z"),
        new Date("2020-01-03T00:00:00.000Z"),
      ],
    ],
  });
  Assert.equal(selected.resultSetId, full.resultSetId);
  Assert.equal(selected.sourceId, full.sourceId);
  Assert.deepEqual(
    selected.items.map(item => item.id),
    ["101", "102", "103", "104"]
  );
  Assert.equal(
    full.items.length,
    9,
    "Refinement does not mutate or display-deduplicate members"
  );
  Assert.deepEqual(
    refineMailSearchResults(full, {
      ownEmails: [],
      dateRanges: [
        [null, new Date("2019-01-01T00:00:00.000Z")],
        [new Date("2030-01-01T00:00:00.000Z"), null],
      ],
    }).items.map(item => item.id),
    ["105", "106", "109"],
    "Ranges are ORed; missing and invalid dates do not become epoch dates"
  );
  Assert.throws(
    () =>
      refineMailSearchResults(full, {
        ownEmails: [],
        dateRanges: [
          [
            new Date("2020-01-03T00:00:00.000Z"),
            new Date("2020-01-01T00:00:00.000Z"),
          ],
        ],
      }),
    /Invalid date range/
  );
});

add_task(function test_booleanPredicatesDoNotConvertUnknownToFalse() {
  const full = facetFixture();
  for (const [filters, ids] of [
    [{ read: false }, ["102", "104", "108", "109"]],
    [{ read: true, starred: true }, ["103"]],
    [{ hasAttachments: true }, ["102", "106"]],
    [{ hasAttachments: false }, ["101", "104"]],
    [{ fromMe: true }, ["101", "105"]],
    [{ toMe: true }, ["102", "103", "104"]],
  ]) {
    Assert.deepEqual(
      refineMailSearchResults(full, {
        ownEmails: ["OWN@example.invalid"],
        ...filters,
      }).items.map(item => item.id),
      ids
    );
  }
  Assert.throws(
    () =>
      refineMailSearchResults(full, {
        ownEmails: [],
        hasAttachments: null,
      }),
    /Unsupported/
  );
  Assert.throws(
    () =>
      refineMailSearchResults(full, {
        ownEmails: [],
        inventedMetadata: false,
      }),
    /Unsupported/
  );
});

add_task(function test_facetCountsRetainUnknownsAndHideOnlyOwnLabels() {
  const full = facetFixture();
  const facets = getMailSearchFacetData(full, {
    ownEmails: ["OWN@example.invalid"],
    now: new Date("2020-01-05T00:00:00.000Z"),
  });
  Assert.equal(facets.resultSetId, "physical-query");
  Assert.equal(facets.sourceId, "physical-core");
  Assert.ok(
    !facets.participants.some(group => group.value == "own@example.invalid")
  );
  Assert.equal(
    full.items.length,
    9,
    "Own-identity display filtering removes no physical member"
  );
  Assert.equal(full.items.find(item => item.id == "107").from, undefined);
  Assert.deepEqual(facets.fromMe.find(group => group.value === null).ids, [
    "107",
  ]);
  Assert.deepEqual(
    facets.hasAttachments.find(group => group.value === false).ids,
    ["101", "104"]
  );
  Assert.deepEqual(
    facets.hasAttachments.find(group => group.value === null).ids,
    ["103", "105", "107", "108", "109"]
  );
  Assert.deepEqual(facets.read.find(group => group.value === null).ids, [
    "106",
    "107",
  ]);
  Assert.deepEqual(facets.folders.find(group => group.value === 20).ids, [
    "102",
  ]);
  Assert.deepEqual(facets.dates.validIds, ["101", "102", "103", "104", "105"]);
  Assert.deepEqual(facets.dates.missingIds, ["107", "108"]);
  Assert.deepEqual(facets.dates.unreasonableIds, ["106", "109"]);
  Assert.equal(facets.dates.oldest.toISOString(), "2019-01-01T00:00:00.000Z");
  Assert.equal(facets.dates.newest.toISOString(), "2020-01-03T00:00:00.000Z");
});

add_task(function test_accountOwnEmailsReflectCurrentSettings() {
  do_get_profile();
  loadExistingDB();
  const account = MailServices.accounts.createAccount();
  const identity = MailServices.accounts.createIdentity();
  identity.email = "FACET-OWN@example.invalid";
  identity.replyTo = "Reply Name <facet-reply@example.invalid>";
  account.addIdentity(identity);
  registerCleanupFunction(() => MailServices.accounts.removeAccount(account));
  Assert.ok(getMailSearchOwnEmails().includes("facet-own@example.invalid"));
  Assert.ok(getMailSearchOwnEmails().includes("facet-reply@example.invalid"));
  identity.email = "facet-renamed@example.invalid";
  Assert.ok(!getMailSearchOwnEmails().includes("facet-own@example.invalid"));
  Assert.ok(getMailSearchOwnEmails().includes("facet-renamed@example.invalid"));
});

add_task(function test_fromMePreservesNonemptyRecipientSemantics() {
  const full = facetFixture();
  full.items = [
    {
      ...full.items[0],
      to: [],
      cc: [],
      bcc: [],
    },
  ];
  Assert.deepEqual(
    refineMailSearchResults(full, {
      ownEmails: ["own@example.invalid"],
      fromMe: true,
    }).items,
    [],
    "Legacy fromMe stores sender/recipient pairs, not a sender alone"
  );
  Assert.deepEqual(
    refineMailSearchResults(full, {
      ownEmails: ["own@example.invalid"],
      fromMe: false,
    }).items.map(item => item.id),
    ["101"]
  );
});

add_task(function test_mimeTypeFacetsKeepPositiveAndUnknownEvidenceSeparate() {
  const set = facetFixture();
  set.items = set.items.slice(0, 4);
  set.items[0].attachmentTypes = {
    types: ["application/pdf", "application/zip"],
    complete: true,
  };
  set.items[1].attachmentTypes = {
    types: ["application/pdf", "application/x-pdf"],
    complete: false,
  };
  set.items[2].attachmentTypes = { types: [], complete: true };
  set.items[3].attachmentTypes = null;
  const facets = getMailSearchFacetData(set, { ownEmails: [] });
  Assert.deepEqual(
    facets.attachmentTypes.find(group => group.value == "application/pdf").ids,
    ["101", "102"]
  );
  Assert.deepEqual(
    facets.attachmentCategories.find(group => group.value == "pdf").ids,
    ["101", "102"],
    "Two PDF types count a physical copy once"
  );
  Assert.deepEqual(
    facets.attachmentCategories.find(group => group.value == "archives").ids,
    ["101"]
  );
  Assert.deepEqual(
    facets.attachmentCategories.find(group => group.value === null).ids,
    ["102", "104"],
    "Known positive types do not prove full encrypted coverage"
  );
  Assert.deepEqual(
    refineMailSearchResults(set, {
      attachmentTypes: ["application/pdf"],
    }).items.map(item => item.id),
    ["101", "102"]
  );
  Assert.deepEqual(
    refineMailSearchResults(set, {
      attachmentCategories: ["archives", "images"],
    }).items.map(item => item.id),
    ["101"]
  );
  Assert.deepEqual(
    refineMailSearchResults(set, { attachmentTypes: ["image/png"] }).items,
    []
  );
  Assert.equal(set.items.length, 4);
  Assert.equal(
    refineMailSearchResults(set, { attachmentCategories: ["pdf"] }).resultSetId,
    "physical-query"
  );
  Assert.throws(
    () => refineMailSearchResults(set, { attachmentTypes: ["report.pdf"] }),
    /facet value/
  );
  Assert.throws(
    () => refineMailSearchResults(set, { attachmentCategories: ["unknown"] }),
    /facet value/
  );
});
