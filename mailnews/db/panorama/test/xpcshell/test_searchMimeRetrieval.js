/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MsgHdrToMimeMessage, MimeMessage, MimeBody } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MimeMessage.sys.mjs"
  );
const { readMailSearchMime, loadMailSearchDocument, loadMailSearchMetadata } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearchContent.sys.mjs"
  );
const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const { processSearchIndexBatch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchIndexer.sys.mjs"
);

let retrievalHeader, healthyRetrievalHeader;
add_setup(function setupMimeRetrieval() {
  do_get_profile();
  loadExistingDB();
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() =>
    hadPref
      ? Services.prefs.setBoolPref(pref, oldPref)
      : Services.prefs.clearUserPref(pref)
  );
  const folder = MailServices.accounts
    .createLocalMailAccount()
    .incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("mime-retrieval")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  retrievalHeader = folder.addMessage(
    "From: sender@example.invalid\r\nSubject: retrievalfixture\r\nContent-Type: text/plain\r\n\r\nactual body\r\n"
  );
  healthyRetrievalHeader = folder.addMessage(
    "From: healthy@example.invalid\r\nSubject: healthyprojectionneedle\r\nContent-Type: text/plain\r\n\r\nhealthybodyneedle\r\n"
  );
});

/**
 * Intercepts this physical header's message service to supply terminal stream
 * callbacks that cannot be induced reliably by corrupting a real mail store.
 *
 * @param {function(object): Promise<void>} exercise - Receives stream controls.
 * @returns {Promise<void>} Resolves after restoring the real message service.
 */
async function withRetrievalStream(exercise) {
  const uri = retrievalHeader.folder.getUriForMsg(retrievalHeader);
  const original = MailServices.messageServiceFromURI;
  const control = { streams: [], failure: null, onStream: null };
  MailServices.messageServiceFromURI = function (candidate) {
    if (candidate != uri) {
      return original.call(this, candidate);
    }
    return {
      streamMessage(
        messageURI,
        consumer,
        window,
        listener,
        convert,
        extra,
        localOnly
      ) {
        if (control.failure) {
          throw control.failure;
        }
        const request = {
          URI: Services.io.newURI("data:text/plain,mime-retrieval"),
          QueryInterface: ChromeUtils.generateQI(["nsIChannel"]),
        };
        const stream = { consumer, listener, localOnly, request };
        control.streams.push(stream);
        control.onStream?.(stream);
      },
    };
  };
  try {
    await exercise(control);
  } finally {
    MailServices.messageServiceFromURI = original;
    for (const stream of control.streams) {
      stream.listener.OnStopRunningUrl(null, Cr.NS_BINDING_ABORTED);
    }
  }
}

/**
 * Supplies the emitter rendezvous and invokes the actual stop listener.
 *
 * @param {object} stream - Captured message-service stream.
 * @param {number} status - Injected original nsresult.
 * @param {?MimeMessage} [mime=null] - Parser result, including a partial failed tree.
 */
function stopRetrieval(stream, status, mime = null) {
  if (mime) {
    MsgHdrToMimeMessage.RESULT_RENDEVOUZ[stream.request.URI.spec] = mime;
  }
  stream.consumer.onStopRequest(stream.request, status);
}

add_task(async function test_sharedCallbacksKeepOriginalStatusAndFinishOnce() {
  await withRetrievalStream(async control => {
    const calls = [];
    MsgHdrToMimeMessage(retrievalHeader, null, (header, mime, status) =>
      calls.push({ header, mime, status })
    );
    MsgHdrToMimeMessage(retrievalHeader, (header, mime) =>
      calls.push({ header, mime })
    );
    Assert.equal(
      control.streams.length,
      1,
      "Legacy two-argument syntax shares the stream"
    );
    Assert.ok(
      control.streams[0].localOnly,
      "The default never requests a download"
    );
    stopRetrieval(
      control.streams[0],
      Cr.NS_ERROR_FILE_NOT_FOUND,
      new MimeMessage()
    );
    control.streams[0].listener.OnStopRunningUrl(
      null,
      Cr.NS_ERROR_FILE_NOT_FOUND
    );
    stopRetrieval(control.streams[0], Cr.NS_ERROR_FILE_NOT_FOUND);
    Assert.equal(calls.length, 2);
    Assert.equal(calls[0].header, retrievalHeader);
    Assert.equal(
      calls[0].mime,
      null,
      "A partial failed parse cannot become evidence"
    );
    Assert.equal(calls[0].status, Cr.NS_ERROR_FILE_NOT_FOUND);
    Assert.equal(calls[1].mime, null);
    Assert.ok(
      !Object.hasOwn(
        MsgHdrToMimeMessage.RESULT_RENDEVOUZ,
        control.streams[0].request.URI.spec
      )
    );

    const failure = new Error("Consumer failure");
    let delivered = 0;
    MsgHdrToMimeMessage(retrievalHeader, null, () => {
      throw failure;
    });
    MsgHdrToMimeMessage(retrievalHeader, null, () => delivered++);
    Assert.equal(
      control.streams.length,
      2,
      "A completed stream is removed before callbacks"
    );
    Assert.throws(
      () => stopRetrieval(control.streams[1], Cr.NS_OK, new MimeMessage()),
      error => error === failure
    );
    Assert.equal(delivered, 1, "One failing consumer does not strand another");
    control.streams[1].listener.OnStopRunningUrl(null, Cr.NS_OK);
    Assert.equal(delivered, 1);
  });
});

add_task(async function test_urlFailureAndMissingTreeAreDistinct() {
  await withRetrievalStream(async control => {
    const failed = readMailSearchMime(retrievalHeader);
    control.streams[0].listener.OnStopRunningUrl(
      null,
      Cr.NS_ERROR_CONNECTION_REFUSED
    );
    await Assert.rejects(
      failed,
      error => error.result === Cr.NS_ERROR_CONNECTION_REFUSED
    );
    stopRetrieval(control.streams[0], Cr.NS_OK, new MimeMessage());
    const missing = readMailSearchMime(retrievalHeader);
    stopRetrieval(control.streams[1], Cr.NS_OK);
    await Assert.rejects(
      missing,
      error =>
        error.message == "MIME stream completed without a MIME result" &&
        error.result === undefined
    );

    const failure = Components.Exception(
      "Original synchronous stream failure",
      Cr.NS_ERROR_FILE_CORRUPTED
    );
    control.failure = failure;
    await Assert.rejects(
      readMailSearchMime(retrievalHeader),
      error => error === failure
    );
    control.failure = null;
    const retry = readMailSearchMime(retrievalHeader, { allowDownload: true });
    Assert.equal(
      control.streams.length,
      3,
      "A synchronous failure does not poison the next retrieval"
    );
    Assert.equal(control.streams[2].localOnly, false);
    const parsed = new MimeMessage();
    stopRetrieval(control.streams[2], Cr.NS_OK, parsed);
    Assert.equal(await retry, parsed);
  });
});

add_task(async function test_cancellationDoesNotCancelAnotherMimeConsumer() {
  await withRetrievalStream(async control => {
    const controller = new AbortController();
    const reason = new Error("Cancel one MIME consumer");
    const cancelled = readMailSearchMime(retrievalHeader, {
      signal: controller.signal,
    });
    const other = readMailSearchMime(retrievalHeader);
    controller.abort(reason);
    await Assert.rejects(cancelled, error => error === reason);
    Assert.equal(control.streams.length, 1);
    const parsed = new MimeMessage();
    stopRetrieval(control.streams[0], Cr.NS_OK, parsed);
    Assert.equal(
      await other,
      parsed,
      "The shared stream still delivers to its other consumer"
    );
    const before = control.streams.length;
    await Assert.rejects(
      readMailSearchMime(retrievalHeader, { signal: controller.signal }),
      error => error === reason
    );
    Assert.equal(
      control.streams.length,
      before,
      "Pre-cancelled retrieval never starts a stream"
    );
  });
});

add_task(async function test_failedRetrievalStaysUnavailableUntilRetry() {
  await withRetrievalStream(async control => {
    const state = {
      eligible: true,
      generation: 1,
      policyRevision: 0,
      contentRevision: "retrieval-1",
      originalContentAvailable: true,
      location: {
        folderId: retrievalHeader.folder.id,
        messageKey: retrievalHeader.messageKey,
      },
      folder: retrievalHeader.folder,
    };
    const id = String(retrievalHeader.messageKey);
    const healthyId = String(healthyRetrievalHeader.messageKey);
    const healthyState = {
      ...state,
      contentRevision: "healthy-1",
      location: {
        folderId: healthyRetrievalHeader.folder.id,
        messageKey: healthyRetrievalHeader.messageKey,
      },
    };
    const states = new Map([
      [id, state],
      [healthyId, healthyState],
    ]);
    const file = do_get_profile().clone();
    file.append("mime-retrieval-failure.sqlite");
    const index = await PanoramaSearchIndex.open(
      file,
      key => states.get(key) ?? null
    );
    const options = { loadMetadata: loadMailSearchMetadata };
    try {
      const unavailable = await loadMailSearchDocument(
        { id, generation: 1, policyRevision: 0, sequence: 1 },
        { ...state, originalContentAvailable: false }
      );
      Assert.equal(unavailable.bodyIndexed, false);
      Assert.equal(unavailable.attachmentPresence, null);
      Assert.equal(unavailable.attachmentTypes, null);
      Assert.equal(unavailable.attachmentInfos, null);
      Assert.equal(
        control.streams.length,
        0,
        "Unavailable original content is not fetched"
      );
      await index.applyChanges({
        sourceId: "retrieval-fixture",
        from: 0,
        through: 2,
        changes: [
          { id, generation: 1, policyRevision: 0, sequence: 1, kind: "index" },
          {
            id: healthyId,
            generation: 1,
            policyRevision: 0,
            sequence: 2,
            kind: "index",
          },
        ],
      });
      control.onStream = stream =>
        stopRetrieval(stream, Cr.NS_ERROR_FILE_CORRUPTED, new MimeMessage());
      const progress = await processSearchIndexBatch(
        index,
        loadMailSearchDocument,
        options
      );
      Assert.equal(progress.unavailable, 1);
      Assert.equal(
        progress.pending,
        0,
        "The same batch finishes its later healthy message"
      );
      Assert.equal((await index.getPendingJobs()).length, 0);
      let text = await index.getText(id);
      Assert.equal(text.bodyIndexed, false);
      Assert.equal(text.body, "");
      Assert.equal(text.attachmentNames, "");
      Assert.equal(text.attachmentPresence, null);
      Assert.equal(text.attachmentTypes, null);
      Assert.equal(
        text.attachmentInfos,
        null,
        "A partial failed tree is not attachment evidence"
      );
      Assert.deepEqual(
        (await index.search("retrievalfixture")).items.map(hit => hit.id),
        [id]
      );
      Assert.deepEqual(
        (await index.search("sender")).items.map(hit => hit.id),
        [id]
      );
      Assert.deepEqual(
        (await index.search("healthyprojectionneedle")).items.map(
          hit => hit.id
        ),
        [healthyId]
      );
      Assert.deepEqual(
        (await index.search("healthybodyneedle")).items.map(hit => hit.id),
        [healthyId]
      );
      Assert.ok((await index.getText(healthyId)).bodyIndexed);

      await index.retryUnavailable();
      Assert.deepEqual(
        (await index.getPendingJobs()).map(job => job.id),
        [id]
      );
      control.onStream = stream => stopRetrieval(stream, Cr.NS_OK);
      const missing = await processSearchIndexBatch(
        index,
        loadMailSearchDocument,
        options
      );
      Assert.equal(missing.unavailable, 1);
      Assert.equal((await index.getText(id)).bodyIndexed, false);
      Assert.equal((await index.getText(id)).attachmentPresence, null);

      await index.retryUnavailable();
      const parsed = new MimeMessage();
      const body = new MimeBody("text/plain");
      body.appendBody("retriedbodyneedle");
      parsed.parts.push(body);
      control.onStream = stream => stopRetrieval(stream, Cr.NS_OK, parsed);
      await processSearchIndexBatch(index, loadMailSearchDocument, options);
      Assert.equal((await index.getProgress()).unavailable, 0);
      text = await index.getText(id);
      Assert.ok(text.bodyIndexed);
      Assert.equal(text.body, "retriedbodyneedle");
      Assert.equal(
        text.attachmentPresence,
        false,
        "Only parsed plain MIME proves absence"
      );
      Assert.deepEqual(
        (await index.search("retriedbodyneedle")).items.map(hit => hit.id),
        [id]
      );

      // A changed body cannot reuse retained text from an earlier generation.
      state.generation = 2;
      state.contentRevision = "retrieval-2";
      await index.applyChanges({
        sourceId: "retrieval-fixture",
        from: 2,
        through: 3,
        changes: [
          { id, generation: 2, policyRevision: 0, sequence: 3, kind: "index" },
        ],
      });
      control.onStream = stream =>
        stopRetrieval(stream, Cr.NS_ERROR_FILE_NOT_FOUND);
      const changed = await processSearchIndexBatch(
        index,
        loadMailSearchDocument,
        options
      );
      Assert.equal(changed.unavailable, 1);
      text = await index.getText(id);
      Assert.equal(text.bodyIndexed, false);
      Assert.equal(text.body, "");
      Assert.equal(text.attachmentPresence, null);
      Assert.deepEqual((await index.search("retriedbodyneedle")).items, []);
      Assert.deepEqual(
        (await index.search("retrievalfixture")).items.map(hit => hit.id),
        [id]
      );

      // An unchanged healthy projection can still reuse its canonical body.
      await index.applyChanges({
        sourceId: "retrieval-fixture",
        from: 3,
        through: 4,
        changes: [
          {
            id: healthyId,
            generation: 1,
            policyRevision: 0,
            sequence: 4,
            kind: "index",
          },
        ],
      });
      await processSearchIndexBatch(
        index,
        () => Assert.ok(false, "Unchanged body needs no MIME load"),
        options
      );
      Assert.equal((await index.getText(healthyId)).body, "healthybodyneedle");
      Assert.equal(
        (await index.getProgress()).unavailable,
        1,
        "Refreshing another header does not complete failed work"
      );
    } finally {
      await index.close();
    }
  });
});

add_task(async function test_documentCancellationLeavesBodyJobPending() {
  await withRetrievalStream(async control => {
    const id = String(retrievalHeader.messageKey);
    const state = {
      eligible: true,
      generation: 1,
      policyRevision: 0,
      contentRevision: "cancel-1",
      originalContentAvailable: true,
      location: {
        folderId: retrievalHeader.folder.id,
        messageKey: retrievalHeader.messageKey,
      },
      folder: retrievalHeader.folder,
    };
    const file = do_get_profile().clone();
    file.append("mime-retrieval-cancel.sqlite");
    const index = await PanoramaSearchIndex.open(file, key =>
      key == id ? state : null
    );
    try {
      await index.applyChanges({
        sourceId: "cancel-fixture",
        from: 0,
        through: 1,
        changes: [
          { id, generation: 1, policyRevision: 0, sequence: 1, kind: "index" },
        ],
      });
      const controller = new AbortController();
      const reason = new Error("Cancel the document loader");
      control.onStream = () => controller.abort(reason);
      await Assert.rejects(
        processSearchIndexBatch(index, loadMailSearchDocument, {
          loadMetadata: loadMailSearchMetadata,
          signal: controller.signal,
        }),
        error => error === reason
      );
      Assert.equal((await index.getProgress()).pending, 1);
      Assert.equal((await index.getProgress()).unavailable, 0);
      Assert.equal(
        await index.getText(id),
        null,
        "Cancellation did not publish a fallback projection"
      );
      Assert.equal(
        control.streams.length,
        1,
        "Cancellation reached the actual MIME retrieval boundary"
      );
    } finally {
      await index.close();
    }
  });
});

add_task(async function test_multipleCallbackErrorsKeepEveryFailure() {
  await withRetrievalStream(async control => {
    const first = new Error("First MIME consumer failure");
    const second = new Error("Second MIME consumer failure");
    const calls = [];
    for (const failure of [first, second]) {
      MsgHdrToMimeMessage(retrievalHeader, null, (header, mime, status) => {
        calls.push({ header, mime, status });
        throw failure;
      });
    }
    MsgHdrToMimeMessage(retrievalHeader, null, (header, mime, status) =>
      calls.push({ header, mime, status })
    );
    Assert.equal(control.streams.length, 1);
    Assert.throws(
      () => stopRetrieval(control.streams[0], Cr.NS_ERROR_FILE_CORRUPTED),
      error =>
        error.name == "AggregateError" &&
        error.message == "MIME consumer callbacks failed" &&
        error.errors.length == 2 &&
        error.errors[0] === first &&
        error.errors[1] === second
    );
    Assert.equal(
      calls.length,
      3,
      "All shared consumers finish despite failures"
    );
    for (const call of calls) {
      Assert.equal(call.header, retrievalHeader);
      Assert.equal(call.mime, null);
      Assert.equal(call.status, Cr.NS_ERROR_FILE_CORRUPTED);
    }
    control.streams[0].listener.OnStopRunningUrl(null, Cr.NS_OK);
    stopRetrieval(control.streams[0], Cr.NS_OK, new MimeMessage());
    Assert.equal(calls.length, 3, "Repeated stop does not redeliver callbacks");
  });
});
