/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { processSearchIndexBatch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchIndexer.sys.mjs"
);

/**
 * Creates an isolated sidecar with independent physical document states.
 *
 * @param {string} name - Unique fixture name.
 * @returns {Promise<object>} Index, source states, file and reopen function.
 */
async function createIndex(name) {
  const file = do_get_profile().clone();
  file.append("search-work-" + name + ".sqlite");
  const states = new Map();
  const open = async () => {
    const index = await PanoramaSearchIndex.open(
      file,
      id => states.get(id) || null
    );
    registerCleanupFunction(() => index.close());
    return index;
  };
  return { index: await open(), states, file, open };
}

/**
 * Creates a literal source change, independent of index internals.
 *
 * @param {string} id - Physical identity.
 * @param {number} sequence - Source sequence.
 * @param {object} [values] - Changed generation, policy or kind.
 * @returns {object} Source change.
 */
function change(id, sequence, values) {
  return {
    id,
    sequence,
    generation: 1,
    policyRevision: 0,
    kind: "index",
    ...values,
  };
}

/**
 * Creates authoritative state and decoded text for a physical fixture.
 *
 * @param {Map} states - Current-state fixture.
 * @param {string} id - Physical identity.
 * @param {string} body - Literal semantic text.
 * @param {object} [values] - Revisions or current-state overrides.
 * @returns {object} Text to index.
 */
function document(states, id, body, values) {
  const state = {
    eligible: true,
    generation: 1,
    policyRevision: 0,
    contentRevision: "text-1",
    location: null,
    originalContentAvailable: false,
    ...values,
  };
  states.set(id, state);
  return {
    id,
    generation: state.generation,
    policyRevision: state.policyRevision,
    contentRevision: state.contentRevision,
    subject: "",
    body,
    attachmentNames: "",
    author: "",
    recipients: "",
  };
}

/**
 * Supplies a complete source page.
 *
 * @param {PanoramaSearchIndex} index - Index under test.
 * @param {number} from - Exclusive checkpoint.
 * @param {number} through - Inclusive checkpoint.
 * @param {object[]} changes - Literal source changes.
 * @returns {Promise<void>} Page commit.
 */
function apply(index, from, through, changes) {
  return index.applyChanges({
    sourceId: "fixture-source",
    from,
    through,
    changes,
  });
}

add_task(async function test_restartCoalescingAndReplay() {
  const fixture = await createIndex("resume");
  let { index } = fixture;
  const a = document(fixture.states, "copy-a", "newgeneration", {
    generation: 2,
    contentRevision: "text-2",
  });
  const b = document(fixture.states, "copy-b", "independentcopy");
  const changes = [
    change("copy-a", 1),
    change("copy-b", 2),
    change("copy-a", 3, { generation: 2 }),
  ];
  await apply(index, 0, 3, changes);
  await index.close();
  index = await fixture.open();
  Assert.deepEqual(await index.getPendingJobs(), [
    { id: "copy-b", generation: 1, policyRevision: 0, sequence: 2 },
    { id: "copy-a", generation: 2, policyRevision: 0, sequence: 3 },
  ]);
  const loaded = [];
  const progress = await processSearchIndexBatch(
    index,
    async job => {
      loaded.push(job.id);
      return b;
    },
    { limit: 1 }
  );
  Assert.deepEqual(loaded, ["copy-b"]);
  Assert.deepEqual(progress, {
    sourceId: "fixture-source",
    acceptedThrough: 3,
    pending: 1,
    unavailable: 0,
  });
  const [job] = await index.getPendingJobs();
  Assert.ok(await index.finishJob(job, a));
  Assert.ok(!(await index.finishJob(job, a)), "Completion is idempotent");
  await apply(index, 0, 3, changes);
  Assert.deepEqual(
    await index.getPendingJobs(),
    [],
    "Replay cannot requeue work"
  );
  Assert.deepEqual(
    (await index.search("newgeneration")).items.map(hit => hit.id),
    ["copy-a"]
  );
  Assert.deepEqual(
    (await index.search("independentcopy")).items.map(hit => hit.id),
    ["copy-b"]
  );
});

add_task(async function test_pageValidationAndRollback() {
  const { index } = await createIndex("rollback");
  await apply(index, 0, 1, [change("existing", 1, { generation: 2 })]);
  await Assert.rejects(
    apply(index, 1, 3, [
      change("must-rollback", 2),
      change("existing", 3, { generation: 1 }),
    ]),
    /backwards/
  );
  Assert.deepEqual(await index.getPendingJobs(), [
    { id: "existing", generation: 2, policyRevision: 0, sequence: 1 },
  ]);
  Assert.equal((await index.getProgress()).acceptedThrough, 1);
  await Assert.rejects(apply(index, 2, 3, []), /gap/);
  await Assert.rejects(
    index.applyChanges({
      sourceId: "different-source",
      from: 0,
      through: 1,
      changes: [],
    }),
    /source changed/
  );
  Assert.throws(
    () => apply(index, 1, 3, [change("later", 3), change("earlier", 2)]),
    /unordered/
  );
  Assert.throws(
    () => apply(index, 1, Number.MAX_SAFE_INTEGER + 1, []),
    /Invalid/
  );
  Assert.equal((await index.getProgress()).acceptedThrough, 1);
});

add_task(async function test_deletionDuringReadPreservesOtherPhysicalCopy() {
  const { index, states } = await createIndex("delete");
  const a = document(states, "copy-a", "sharedneedle");
  const b = document(states, "copy-b", "sharedneedle");
  await apply(index, 0, 2, [change("copy-a", 1), change("copy-b", 2)]);
  const [oldA, jobB] = await index.getPendingJobs();
  Assert.ok(await index.finishJob(jobB, b));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  registerCleanupFunction(() => release.resolve());
  const running = processSearchIndexBatch(index, async () => {
    entered.resolve();
    await release.promise;
    return a;
  });
  await entered.promise;
  await apply(index, 2, 3, [
    change("copy-a", 3, { generation: 2, kind: "delete" }),
  ]);
  states.delete("copy-a");
  release.resolve();
  await running;
  Assert.ok(
    !(await index.finishJob(oldA, a)),
    "Late read cannot undo deletion"
  );
  states.set("copy-a", { ...states.get("copy-b") });
  Assert.ok(
    !(await index.index(a)),
    "Durable deletion also rejects a stale resolver"
  );
  await index.rebuild();
  Assert.deepEqual(
    (await index.search("sharedneedle")).items.map(hit => hit.id),
    ["copy-b"]
  );
  Assert.equal(await index.getText("copy-a"), null);
});

add_task(async function test_newGenerationRejectsOldCompletion() {
  const { index, states } = await createIndex("generation");
  const oldText = document(states, "physical", "oldneedle");
  await apply(index, 0, 1, [change("physical", 1)]);
  const [oldJob] = await index.getPendingJobs();
  const newText = document(states, "physical", "newneedle", {
    generation: 2,
    contentRevision: "text-2",
  });
  await apply(index, 1, 2, [change("physical", 2, { generation: 2 })]);
  Assert.equal(await index.getJobState(oldJob), null);
  Assert.ok(!(await index.finishJob(oldJob, oldText)));
  const [newJob] = await index.getPendingJobs();
  Assert.equal(
    newJob.sequence,
    2,
    "Old completion did not acknowledge new work"
  );
  Assert.ok(await index.finishJob(newJob, newText));
  Assert.deepEqual((await index.search("oldneedle")).items, []);
  Assert.deepEqual(
    (await index.search("newneedle")).items.map(hit => hit.id),
    ["physical"]
  );
});

add_task(async function test_policyExclusionAndRebuild() {
  const { index, states } = await createIndex("policy");
  const oldText = document(states, "physical", "excludedneedle");
  await apply(index, 0, 1, [change("physical", 1)]);
  const [oldJob] = await index.getPendingJobs();
  Assert.ok(await index.finishJob(oldJob, oldText));
  await apply(index, 1, 2, [
    change("physical", 2, { policyRevision: 1, kind: "exclude" }),
  ]);
  states.get("physical").policyRevision = 1;
  states.get("physical").eligible = false;
  await index.rebuild();
  Assert.deepEqual((await index.search("excludedneedle")).items, []);
  Assert.equal(await index.getText("physical"), null);
  Assert.ok(!(await index.index(oldText)));
  const newText = document(states, "physical", "allowedneedle", {
    policyRevision: 2,
    contentRevision: "text-policy-2",
  });
  await apply(index, 2, 3, [change("physical", 3, { policyRevision: 2 })]);
  await index.rebuild();
  Assert.deepEqual((await index.search("excludedneedle")).items, []);
  const [newJob] = await index.getPendingJobs();
  Assert.ok(!(await index.finishJob(oldJob, oldText)));
  Assert.ok(await index.finishJob(newJob, newText));
  Assert.deepEqual(
    (await index.search("allowedneedle")).items.map(hit => hit.id),
    ["physical"]
  );
});

add_task(async function test_unavailableRetryAndCancellation() {
  const fixture = await createIndex("unavailable");
  let { index } = fixture;
  const text = document(fixture.states, "physical", "retryneedle");
  await apply(index, 0, 1, [change("physical", 1)]);
  await processSearchIndexBatch(index, async () => null);
  await index.close();
  index = await fixture.open();
  Assert.deepEqual(await index.getProgress(), {
    sourceId: "fixture-source",
    acceptedThrough: 1,
    pending: 0,
    unavailable: 1,
  });
  Assert.deepEqual(await index.getPendingJobs(), []);
  Assert.deepEqual((await index.search("retryneedle")).items, []);
  await index.retryUnavailable();
  const controller = new AbortController();
  const reason = new Error("Stop indexing");
  await Assert.rejects(
    processSearchIndexBatch(
      index,
      async () => {
        controller.abort(reason);
        return text;
      },
      { signal: controller.signal }
    ),
    error => error === reason
  );
  Assert.equal(
    (await index.getProgress()).pending,
    1,
    "Cancelled work remains durable"
  );
  await processSearchIndexBatch(index, async () => text);
  Assert.equal((await index.getProgress()).pending, 0);
  Assert.deepEqual(
    (await index.search("retryneedle")).items.map(hit => hit.id),
    ["physical"]
  );
});

add_task(async function test_metadataResultsWhileBodyUnavailable() {
  const fixture = await createIndex("metadata");
  let { index } = fixture;
  const metadata = document(fixture.states, "physical", "");
  metadata.subject = "headerneedle";
  metadata.bodyIndexed = false;
  await apply(index, 0, 1, [change("physical", 1)]);
  await processSearchIndexBatch(index, async () => metadata);
  Assert.equal((await index.getProgress()).unavailable, 1);
  const page = await index.search("headerneedle");
  Assert.deepEqual(
    page.items.map(hit => hit.id),
    ["physical"]
  );
  Assert.equal(page.items[0].bodyIndexed, false);
  Assert.equal(page.items[0].originalContentAvailable, false);
  Assert.equal((await index.getText("physical")).bodyIndexed, false);
  await index.close();
  index = await fixture.open();
  Assert.equal((await index.getProgress()).unavailable, 1);
  Assert.equal(
    (await index.search("headerneedle")).items[0].bodyIndexed,
    false
  );
  Assert.deepEqual((await index.search("bodyneedle")).items, []);

  // The source revision names the newly available semantic text.
  fixture.states.get("physical").contentRevision = "text-with-body";
  const complete = {
    ...metadata,
    contentRevision: "text-with-body",
    body: "bodyneedle",
    bodyIndexed: true,
  };
  await index.retryUnavailable();
  await processSearchIndexBatch(index, async () => complete);
  Assert.equal((await index.getProgress()).unavailable, 0);
  Assert.equal((await index.getProgress()).pending, 0);
  Assert.equal((await index.search("bodyneedle")).items[0].bodyIndexed, true);
  Assert.equal((await index.getText("physical")).body, "bodyneedle");
});

add_task(async function test_retainedBodySurvivesMetadataRefresh() {
  const fixture = await createIndex("retained-body");
  let { index } = fixture;
  const full = document(fixture.states, "physical", "recoveredneedle");
  full.subject = "headerneedle";
  await apply(index, 0, 1, [change("physical", 1)]);
  await processSearchIndexBatch(index, async () => full);
  const original = (await index.search("recoveredneedle")).items[0];
  Assert.equal(
    original.textRevision,
    (await index.getText("physical")).textRevision
  );
  await index.rebuild();
  Assert.equal(
    (await index.search("recoveredneedle")).items[0].textRevision,
    original.textRevision,
    "Rebuilding FTS does not change the underlying semantic text"
  );

  fixture.states.get("physical").contentRevision = "metadata-only";
  const metadata = {
    ...full,
    contentRevision: "metadata-only",
    body: "",
    bodyIndexed: false,
  };
  await apply(index, 1, 2, [change("physical", 2)]);
  await processSearchIndexBatch(index, async () => metadata);
  const projected = (await index.search("headerneedle")).items[0];
  Assert.equal(projected.bodyIndexed, false);
  Assert.notEqual(projected.textRevision, original.textRevision);
  Assert.equal(
    projected.textRevision,
    (await index.getText("physical")).textRevision
  );
  Assert.deepEqual((await index.search("recoveredneedle")).items, []);
  await index.close();
  index = await fixture.open();

  // The authoritative fixture revalidates the retained semantic revision.
  fixture.states.get("physical").contentRevision = "text-1";
  await index.retryUnavailable();
  await processSearchIndexBatch(index, async () => ({
    ...metadata,
    contentRevision: "text-1",
  }));
  const restored = (await index.search("recoveredneedle")).items[0];
  Assert.equal(restored.bodyIndexed, true);
  Assert.equal(restored.originalContentAvailable, false);
  Assert.equal(
    restored.textRevision,
    (await index.getText("physical")).textRevision
  );
  Assert.equal((await index.getText("physical")).body, "recoveredneedle");
  Assert.equal((await index.getProgress()).unavailable, 0);
});

add_task(async function test_metadataCannotReuseBodyAcrossPolicyRevision() {
  const { index, states } = await createIndex("retained-policy");
  const full = document(states, "physical", "protectedneedle");
  full.subject = "headerneedle";
  await apply(index, 0, 1, [change("physical", 1)]);
  await processSearchIndexBatch(index, async () => full);

  states.get("physical").policyRevision = 1;
  await apply(index, 1, 2, [change("physical", 2, { policyRevision: 1 })]);
  await processSearchIndexBatch(index, async () => ({
    ...full,
    policyRevision: 1,
    body: "",
    bodyIndexed: false,
  }));
  await index.rebuild();
  Assert.equal(
    (await index.search("headerneedle")).items[0].bodyIndexed,
    false
  );
  Assert.deepEqual((await index.search("protectedneedle")).items, []);
  Assert.equal((await index.getText("physical")).body, "");
  Assert.equal((await index.getProgress()).unavailable, 1);
});

add_task(async function test_loaderFailureDoesNotStarveLaterWork() {
  const { index, states } = await createIndex("loader-failure");
  const failed = document(states, "failed", "failedloadneedle");
  const later = document(states, "later", "laterloadneedle");
  await apply(index, 0, 2, [change("failed", 1), change("later", 2)]);
  const failure = new Error("MIME body load failed");
  await Assert.rejects(
    processSearchIndexBatch(
      index,
      async () => {
        throw failure;
      },
      { limit: 1 }
    ),
    error => error === failure
  );
  Assert.deepEqual(await index.getProgress(), {
    sourceId: "fixture-source",
    acceptedThrough: 2,
    pending: 1,
    unavailable: 1,
  });
  Assert.equal(
    await index.getText("failed"),
    null,
    "Failed text was not indexed"
  );
  Assert.deepEqual((await index.search("failedloadneedle")).items, []);
  await processSearchIndexBatch(
    index,
    async job => {
      Assert.equal(job.id, "later", "A later batch bypasses the failed loader");
      return later;
    },
    { limit: 1 }
  );
  Assert.deepEqual(
    (await index.search("laterloadneedle")).items.map(hit => hit.id),
    ["later"]
  );
  Assert.equal((await index.getProgress()).unavailable, 1);
  await index.retryUnavailable();
  await processSearchIndexBatch(index, async job => {
    Assert.equal(job.id, "failed");
    return failed;
  });
  Assert.equal((await index.getProgress()).unavailable, 0);
  Assert.deepEqual(
    (await index.search("failedloadneedle")).items.map(hit => hit.id),
    ["failed"]
  );
});

add_task(async function test_abortedLoaderFailureStaysPending() {
  const { index, states } = await createIndex("aborted-loader");
  document(states, "cancelled", "cancelledloadneedle");
  await apply(index, 0, 1, [change("cancelled", 1)]);
  const controller = new AbortController();
  const reason = new Error("Cancel loader");
  await Assert.rejects(
    processSearchIndexBatch(
      index,
      async () => {
        controller.abort(reason);
        throw reason;
      },
      { signal: controller.signal }
    ),
    error => error === reason
  );
  Assert.equal((await index.getProgress()).pending, 1);
  Assert.equal((await index.getProgress()).unavailable, 0);
});

add_task(async function test_attachmentProofRetainsExactSourceGuards() {
  const fixture = await createIndex("attachment-presence");
  let { index } = fixture;
  const full = {
    ...document(fixture.states, "physical", "attachmentproofneedle"),
    attachmentPresence: true,
  };
  await apply(index, 0, 1, [change("physical", 1)]);
  await processSearchIndexBatch(index, async () => full);
  Assert.equal((await index.getText("physical")).attachmentPresence, true);

  fixture.states.get("physical").contentRevision = "metadata-only";
  await apply(index, 1, 2, [change("physical", 2)]);
  await processSearchIndexBatch(index, async () => ({
    ...full,
    contentRevision: "metadata-only",
    body: "",
    bodyIndexed: false,
    attachmentPresence: null,
  }));
  Assert.equal((await index.getText("physical")).attachmentPresence, null);
  await index.close();
  index = await fixture.open();
  fixture.states.get("physical").contentRevision = "text-1";
  await index.retryUnavailable();
  await processSearchIndexBatch(index, async () => ({
    ...full,
    body: "",
    bodyIndexed: false,
    attachmentPresence: null,
  }));
  Assert.equal((await index.getText("physical")).attachmentPresence, true);

  fixture.states.get("physical").generation = 2;
  await apply(index, 2, 3, [change("physical", 3, { generation: 2 })]);
  await processSearchIndexBatch(index, async () => ({
    ...full,
    generation: 2,
    body: "",
    bodyIndexed: false,
    attachmentPresence: null,
  }));
  Assert.equal((await index.getText("physical")).attachmentPresence, null);
  Assert.deepEqual((await index.search("attachmentproofneedle")).items, []);
});

add_task(async function test_metadataRefreshReusesOnlyUnchangedCanonicalBody() {
  const { index, states } = await createIndex("metadata-refresh");
  const original = document(states, "physical-a", "retainedbodyneedle");
  await apply(index, 0, 1, [change("physical-a", 1)]);
  Assert.ok(await index.finishJob((await index.getPendingJobs())[0], original));
  const oldText = await index.getText("physical-a");
  const metadata = document(states, "physical-a", "", {
    generation: 2,
    policyRevision: 3,
  });
  metadata.bodyIndexed = false;
  metadata.author = "NewCardName";
  await apply(index, 1, 2, [
    change("physical-a", 2, { generation: 2, policyRevision: 3 }),
  ]);
  let loads = 0;
  await processSearchIndexBatch(
    index,
    async () => {
      loads++;
      throw new Error("Unchanged MIME must not be loaded");
    },
    { loadMetadata: () => metadata }
  );
  Assert.equal(loads, 0);
  const refreshed = await index.getText("physical-a");
  Assert.equal(refreshed.body, "retainedbodyneedle");
  Assert.equal(refreshed.author, "NewCardName");
  Assert.equal(refreshed.generation, 2);
  Assert.equal(refreshed.policyRevision, 3);
  Assert.notEqual(refreshed.textRevision, oldText.textRevision);
  Assert.deepEqual(
    (await index.search("NewCardName")).items.map(hit => hit.id),
    ["physical-a"]
  );
  Assert.equal((await index.getProgress()).pending, 0);

  const changed = document(states, "physical-a", "", {
    generation: 4,
    policyRevision: 3,
    contentRevision: "text-2",
  });
  changed.bodyIndexed = false;
  await apply(index, 2, 4, [
    change("physical-a", 4, { generation: 4, policyRevision: 3 }),
  ]);
  const [job] = await index.getPendingJobs();
  Assert.equal(
    await index.refreshJob(job, changed),
    false,
    "A changed body cannot be promoted"
  );
  states.get("physical-a").contentRevision = "text-1";
  states.get("physical-a").eligible = false;
  Assert.equal(
    await index.refreshJob(job, { ...metadata, generation: 4 }),
    false
  );
  states.delete("physical-a");
  Assert.equal(
    await index.refreshJob(job, { ...metadata, generation: 4 }),
    false
  );
  await apply(index, 4, 5, [
    change("physical-a", 5, {
      generation: 5,
      kind: "delete",
      policyRevision: 3,
    }),
  ]);
  Assert.equal(
    await index.refreshJob(job, { ...metadata, generation: 4 }),
    false
  );
  Assert.deepEqual((await index.search("retainedbodyneedle")).items, []);
});

add_task(async function test_addressBookRefreshIsBoundedDurableAndCoalesced() {
  const fixture = await createIndex("address-refresh");
  let { index } = fixture;
  const a = document(fixture.states, "physical-a", "firstbody");
  const b = document(fixture.states, "physical-b", "secondbody");
  a.author = b.author = "OldBookName";
  await apply(index, 0, 2, [change("physical-a", 1), change("physical-b", 2)]);
  for (const job of await index.getPendingJobs()) {
    await index.finishJob(job, job.id == a.id ? a : b);
  }
  await index.prepareAddressBook(10);
  await index.prepareAddressBook(11);
  Assert.deepEqual(
    (await index.search("OldBookName")).items,
    [],
    "Unvisited old names are hidden"
  );
  Assert.ok(await index.refreshAddressBook(1));
  Assert.deepEqual(
    (await index.getPendingJobs()).map(job => job.id),
    ["physical-a"]
  );
  await index.prepareAddressBook(11);
  await index.close();
  index = await fixture.open();
  Assert.ok(await index.refreshAddressBook(1));
  Assert.deepEqual(
    (await index.getPendingJobs()).map(job => job.id),
    ["physical-a", "physical-b"],
    "Same version and reopen keep the cursor"
  );
  await index.rebuild();
  Assert.deepEqual(
    (await index.search("OldBookName")).items,
    [],
    "Rebuild cannot resurrect invalidated projections"
  );
  const [firstJob] = await index.getPendingJobs();
  await index.markUnavailable(firstJob);
  Assert.equal(await index.refreshAddressBook(1), false);
  Assert.equal((await index.getProgress()).unavailable, 1);
  await processSearchIndexBatch(
    index,
    async () => {
      throw new Error("No MIME load");
    },
    {
      loadMetadata: job => ({
        ...(job.id == a.id ? a : b),
        author: "CurrentBookName",
        body: "",
        bodyIndexed: false,
      }),
    }
  );
  Assert.deepEqual(
    (await index.search("CurrentBookName")).items.map(hit => hit.id),
    ["physical-b"]
  );
  Assert.deepEqual((await index.search("OldBookName")).items, []);
  Assert.equal(
    (await index.getProgress()).acceptedThrough,
    2,
    "No native journal checkpoint was invented"
  );
  await index.retryUnavailable();
  await processSearchIndexBatch(
    index,
    async () => {
      throw new Error("No MIME load");
    },
    {
      loadMetadata: () => ({
        ...a,
        author: "CurrentBookName",
        body: "",
        bodyIndexed: false,
      }),
    }
  );
  Assert.deepEqual(
    (await index.search("firstbody")).items.map(hit => hit.id),
    ["physical-a"]
  );
});

add_task(async function test_mimeEvidenceSurvivesRefreshAndReopen() {
  const fixture = await createIndex("mime-evidence");
  let { index } = fixture;
  const original = document(fixture.states, "mime-copy", "mimebody");
  original.attachmentTypes = { types: ["image/png"], complete: false };
  await apply(index, 0, 1, [change("mime-copy", 1)]);
  await index.finishJob((await index.getPendingJobs())[0], original);
  const refreshed = document(fixture.states, "mime-copy", "", {
    generation: 2,
  });
  refreshed.bodyIndexed = false;
  await apply(index, 1, 2, [change("mime-copy", 2, { generation: 2 })]);
  Assert.ok(
    await index.refreshJob((await index.getPendingJobs())[0], refreshed)
  );
  await index.close();
  index = await fixture.open();
  Assert.deepEqual((await index.getText("mime-copy")).attachmentTypes, {
    types: ["image/png"],
    complete: false,
  });
  const oldEvidence = document(fixture.states, "old-copy", "recoveredbody");
  await index.index(oldEvidence);
  Assert.equal(
    (await index.getText("old-copy")).attachmentTypes,
    null,
    "Missing metadata stays unknown"
  );
});

add_task(async function test_revisionOnlyRefreshPreservesTextAndUtf8Offsets() {
  const { index, states } = await createIndex("revision-only");
  const text = document(states, "revision-copy", "é needle");
  await apply(index, 0, 1, [change("revision-copy", 1)]);
  await index.finishJob((await index.getPendingJobs())[0], text);
  const before = await index.getText("revision-copy");
  const metadata = document(states, "revision-copy", "", { generation: 2 });
  metadata.bodyIndexed = false;
  await apply(index, 1, 2, [change("revision-copy", 2, { generation: 2 })]);
  Assert.deepEqual(
    (await index.search("needle")).items,
    [],
    "The old native generation stays hidden"
  );
  Assert.ok(
    await index.refreshJob((await index.getPendingJobs())[0], metadata)
  );
  const after = await index.getText("revision-copy");
  Assert.equal(after.body, "é needle");
  Assert.equal(
    after.textRevision,
    before.textRevision,
    "Exact stored text did not change"
  );
  const hits = (await index.search("needle")).items;
  Assert.deepEqual(
    hits.map(hit => hit.id),
    ["revision-copy"]
  );
  Assert.equal(hits[0].generation, 2);
  Assert.equal(hits[0].offsetsUtf8, "1 0 3 6");
});

add_task(async function test_metadataLoaderFailureDoesNotStarveLaterJobs() {
  const { index, states } = await createIndex("metadata-loader-error");
  const a = document(states, "failed-copy", "failedbody");
  const b = document(states, "good-copy", "goodbody");
  await apply(index, 0, 2, [change(a.id, 1), change(b.id, 2)]);
  const failure = new Error("Address-book metadata lookup failed");
  const options = {
    loadMetadata: job => {
      if (job.id == a.id) {
        throw failure;
      }
      return { ...b, body: "", bodyIndexed: false };
    },
  };
  await Assert.rejects(
    processSearchIndexBatch(index, () => b, options),
    error => error === failure
  );
  Assert.equal((await index.getProgress()).unavailable, 1);
  await processSearchIndexBatch(index, () => b, options);
  Assert.deepEqual(
    (await index.search("goodbody")).items.map(hit => hit.id),
    ["good-copy"]
  );
  Assert.deepEqual((await index.search("failedbody")).items, []);
  Assert.equal((await index.getProgress()).pending, 0);
});

add_task(
  async function test_attachmentDetailsFollowCanonicalAndRetainedGuards() {
    const fixture = await createIndex("attachment-details");
    let { index } = fixture;
    const details = {
      complete: false,
      items: [
        {
          name: "report.pdf",
          contentType: "application/pdf",
          size: null,
          part: "1.2",
          isExternal: false,
          externalUrl: null,
        },
      ],
    };
    const full = {
      ...document(fixture.states, "details-copy", "detailsbody"),
      attachmentInfos: details,
    };
    await apply(index, 0, 1, [change("details-copy", 1)]);
    await index.finishJob((await index.getPendingJobs())[0], full);
    await index.close();
    index = await fixture.open();
    Assert.deepEqual(
      (await index.getText("details-copy")).attachmentInfos,
      details
    );
    const metadata = {
      ...document(fixture.states, "details-copy", "", { generation: 2 }),
      bodyIndexed: false,
      attachmentInfos: null,
    };
    await apply(index, 1, 2, [change("details-copy", 2, { generation: 2 })]);
    Assert.ok(
      await index.refreshJob((await index.getPendingJobs())[0], metadata)
    );
    Assert.deepEqual(
      (await index.getText("details-copy")).attachmentInfos,
      details
    );

    fixture.states.get("details-copy").contentRevision = "body-2";
    await apply(index, 2, 3, [change("details-copy", 3, { generation: 2 })]);
    await index.finishJob((await index.getPendingJobs())[0], {
      ...metadata,
      contentRevision: "body-2",
    });
    Assert.equal((await index.getText("details-copy")).attachmentInfos, null);
    await index.close();
    index = await fixture.open();
    fixture.states.get("details-copy").generation = 3;
    fixture.states.get("details-copy").contentRevision = "text-1";
    await apply(index, 3, 4, [change("details-copy", 4, { generation: 3 })]);
    await index.finishJob((await index.getPendingJobs())[0], {
      ...metadata,
      generation: 3,
    });
    Assert.equal(
      (await index.getText("details-copy")).attachmentInfos,
      null,
      "An old retained body cannot cross the generation guard"
    );
    fixture.states.get("details-copy").eligible = false;
    Assert.equal(await index.getText("details-copy"), null);
    fixture.states.delete("details-copy");
    await apply(index, 4, 5, [
      change("details-copy", 5, { generation: 4, kind: "delete" }),
    ]);
    Assert.equal(await index.getText("details-copy"), null);
  }
);

add_task(async function test_recoveryRescanPreservesEligibleSources() {
  const fixture = await createIndex("recovery-policy-rescan");
  let { index } = fixture;
  const originals = ["survivor", "excluded", "changed", "deleted"].map(id =>
    document(fixture.states, id, id + "recoveryneedle")
  );
  const records = originals.map(source => ({
    recordId: "receipt-" + source.id,
    documentId: source.id,
    kind: "mail",
    sourceRevision: "a".repeat(64),
    payload: {
      originalKey: source.id,
      importReceipt: { keys: [[1, source.id]] },
    },
    document: source,
  }));
  await index.retainRecovery(records);
  await apply(
    index,
    0,
    4,
    originals.map((source, i) => change(source.id, i + 1))
  );
  for (const job of await index.getPendingJobs()) {
    Assert.ok(
      await index.finishJob(
        job,
        originals.find(row => row.id === job.id)
      )
    );
  }
  const provenance = await index.getRecoveryRecords();
  for (const state of fixture.states.values()) {
    state.generation = 5;
    state.policyRevision = 5;
  }
  fixture.states.get("excluded").eligible = false;
  fixture.states.get("changed").contentRevision = "text-2";
  Assert.equal(
    await index.getRecoveredText("survivor"),
    null,
    "Current eligibility alone cannot authorize a changed policy"
  );
  await index.beginRescan("fixture-source", 5);
  await index.applyRescanPage({
    sequence: 5,
    afterKey: 0,
    nextKey: 4,
    changes: originals.map(source =>
      change(source.id, 5, {
        generation: 5,
        policyRevision: 5,
        kind: source.id === "excluded" ? "exclude" : "index",
      })
    ),
  });
  await index.applyRescanPage({
    sequence: 5,
    afterKey: 4,
    nextKey: 4,
    changes: [],
    done: true,
  });
  const retained = await index.getRecoveredText("survivor");
  Assert.equal(retained.body, originals[0].body);
  Assert.equal(retained.policyRevision, 5);
  Assert.equal(retained.generation, 5);
  Assert.equal(await index.getRecoveredText("excluded"), null);
  Assert.equal(await index.getRecoveredText("changed"), null);
  const metadata = {
    ...originals[0],
    generation: 5,
    policyRevision: 5,
    body: "",
    bodyIndexed: false,
  };
  Assert.ok(
    await index.refreshJob(
      (await index.getPendingJobs()).find(job => job.id === "survivor"),
      metadata
    )
  );
  Assert.equal((await index.getText("survivor")).body, originals[0].body);
  Assert.deepEqual(
    await index.getRecoveryRecords(),
    provenance,
    "Policy authorization does not rewrite any source revision, identity or receipt"
  );
  await index.close();
  index = await fixture.open();
  Assert.equal(
    (await index.getRecoveredText("survivor")).body,
    originals[0].body
  );
  for (const state of fixture.states.values()) {
    state.generation = 6;
    state.policyRevision = 6;
  }
  fixture.states.get("excluded").eligible = true;
  await index.beginRescan("fixture-source", 6);
  await index.applyRescanPage({
    sequence: 6,
    afterKey: 0,
    nextKey: 4,
    changes: originals.map(source =>
      change(source.id, 6, { generation: 6, policyRevision: 6 })
    ),
  });
  await index.applyRescanPage({
    sequence: 6,
    afterKey: 4,
    nextKey: 4,
    changes: [],
    done: true,
  });
  Assert.equal(
    await index.getRecoveredText("excluded"),
    null,
    "An eligible rescan after reopen cannot revive an excluded backup"
  );
  const excludedMetadata = {
    ...originals[1],
    generation: 6,
    policyRevision: 6,
    body: "",
    bodyIndexed: false,
  };
  Assert.equal(
    await index.refreshJob(
      (await index.getPendingJobs()).find(job => job.id === "excluded"),
      excludedMetadata
    ),
    false
  );
  Assert.equal(await index.getRecoveredText("changed"), null);
  Assert.equal(
    (await index.getRecoveredText("survivor")).body,
    originals[0].body
  );
  Assert.deepEqual(await index.getRecoveryRecords(), provenance);
  fixture.states.delete("deleted");
  await apply(index, 6, 7, [
    change("deleted", 7, { generation: 7, policyRevision: 6, kind: "delete" }),
  ]);
  await index.retainRecovery(records);
  const [erased] = await index.getRecoveryRecords("deleted");
  Assert.ok(erased.erased);
  Assert.equal(erased.payload, null);
  Assert.equal(await index.getRecoveredText("deleted"), null);
  await index.rebuild();
  Assert.deepEqual((await index.search("excludedrecoveryneedle")).items, []);
  Assert.deepEqual((await index.search("deletedrecoveryneedle")).items, []);

  // A pre-upgrade record has no evidence that intervening policy was observed.
  const legacy = await createIndex("legacy-recovery-policy");
  const source = document(legacy.states, "legacy", "legacyrecoveryneedle");
  await legacy.index.retainRecovery([
    {
      ...records[0],
      recordId: "legacy-record",
      documentId: "legacy",
      document: source,
    },
  ]);
  await apply(legacy.index, 0, 1, [change("legacy", 1)]);
  await legacy.index.close();
  const connection = Services.storage.openUnsharedDatabase(legacy.file);
  try {
    connection.executeSimpleSQL("DROP TABLE recovery_policy");
    connection.schemaVersion = 7;
  } finally {
    connection.close();
  }
  const upgraded = await legacy.open();
  Assert.equal((await upgraded.getRecoveredText("legacy")).body, source.body);
  legacy.states.get("legacy").generation = 2;
  legacy.states.get("legacy").policyRevision = 2;
  await upgraded.beginRescan("fixture-source", 2);
  await upgraded.applyRescanPage({
    sequence: 2,
    afterKey: 0,
    nextKey: 1,
    changes: [change("legacy", 2, { generation: 2, policyRevision: 2 })],
  });
  await upgraded.applyRescanPage({
    sequence: 2,
    afterKey: 1,
    nextKey: 1,
    changes: [],
    done: true,
  });
  Assert.equal(
    await upgraded.getRecoveredText("legacy"),
    null,
    "Upgrade cannot invent unobserved authorization history"
  );
});

add_task(async function test_exclusionDropsCanonicalText() {
  const fixture = await createIndex("excluded-canonical-text");
  let { index } = fixture;
  const originals = ["full", "retained", "peer"].map(id =>
    document(fixture.states, id, id + "exclusionneedle")
  );
  await apply(
    index,
    0,
    3,
    originals.map((source, i) => change(source.id, i + 1))
  );
  for (const job of await index.getPendingJobs()) {
    Assert.ok(
      await index.finishJob(job, originals.find(source => source.id === job.id))
    );
  }

  fixture.states.get("retained").contentRevision = "metadata-2";
  await apply(index, 3, 4, [change("retained", 4)]);
  await processSearchIndexBatch(index, async () => ({
    ...originals[1],
    contentRevision: "metadata-2",
    body: "",
    bodyIndexed: false,
  }));
  await index.close();
  let connection = Services.storage.openUnsharedDatabase(fixture.file);
  let statement = connection.createStatement("SELECT COUNT(*) FROM retained_bodies");
  try {
    Assert.ok(statement.executeStep());
    Assert.equal(statement.getInt64(0), 1, "The fixture retains the old body");
  } finally {
    statement.finalize();
    connection.close();
  }

  index = await fixture.open();
  for (const id of ["full", "retained"]) {
    fixture.states.get(id).eligible = false;
    fixture.states.get(id).policyRevision = 1;
  }
  await apply(index, 4, 6, [
    change("full", 5, { policyRevision: 1, kind: "exclude" }),
    change("retained", 6, { policyRevision: 1, kind: "exclude" }),
  ]);
  Assert.equal(await index.getText("full"), null);
  Assert.equal(await index.getText("retained"), null);
  await index.close();

  connection = Services.storage.openUnsharedDatabase(fixture.file);
  Cc["@mozilla.org/messenger/fts3tokenizer;1"]
    .getService(Ci.nsIFts3Tokenizer)
    .registerTokenizer(connection);
  statement = connection.createStatement(
    "SELECT " +
      "(SELECT COUNT(*) FROM documents), " +
      "(SELECT COUNT(*) FROM retained_bodies), " +
      "(SELECT COUNT(*) FROM search_text), " +
      "(SELECT COUNT(*) FROM document_versions WHERE kind='exclude'), " +
      "(SELECT COUNT(*) FROM recovery_erased)"
  );
  try {
    Assert.ok(statement.executeStep());
    Assert.equal(statement.getInt64(0), 1, "Only the eligible peer keeps canonical text");
    Assert.equal(statement.getInt64(1), 0, "Excluded retained bodies are removed");
    Assert.equal(statement.getInt64(2), 1, "Only the eligible peer keeps FTS text");
    Assert.equal(statement.getInt64(3), 2, "Both exclusions remain durable");
    Assert.equal(statement.getInt64(4), 0, "Exclusion does not forge permanent erasure");
  } finally {
    statement.finalize();
    connection.close();
  }

  index = await fixture.open();
  await index.rebuild();
  Assert.equal(await index.getText("full"), null);
  Assert.equal(await index.getText("retained"), null);
  Assert.deepEqual((await index.search("fullexclusionneedle")).items, []);
  Assert.deepEqual((await index.search("retainedexclusionneedle")).items, []);
  Assert.deepEqual(
    (await index.search("peerexclusionneedle")).items.map(hit => hit.id),
    ["peer"]
  );
});
