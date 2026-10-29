/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Loads one bounded batch and leaves unfinished jobs durable for the next call.
 * Cancellation stops new loads. The loader must honor the signal while reading
 * content. A sidecar commit already in progress completes before this returns.
 * A failed load becomes unavailable before its error is rethrown. Later batches
 * can advance; only an explicit retry or a newer source change revives that job.
 *
 * @param {PanoramaSearchIndex} index - Open search sidecar.
 * @param {function(SearchIndexJob, SearchDocumentState, AbortSignal=): Promise<?SearchDocument>} loadDocument -
 *   Load policy-approved text, or null when the source is unavailable.
 * @param {object} [options] - Batch controls.
 * @param {function(SearchIndexJob, SearchDocumentState, AbortSignal=): ?SearchDocument} [options.loadMetadata] -
 *   Copy native mail headers before attempting unchanged-body reuse.
 * @param {number} [options.limit=20] - Maximum jobs to attempt.
 * @param {AbortSignal} [options.signal] - Cancellation passed to the loader.
 * @param {function({sourceId: ?string, acceptedThrough: number, pending: number,
 *   unavailable: number}): void} [options.onProgress] - Durable progress callback.
 * @returns {Promise<{sourceId: ?string, acceptedThrough: number, pending: number,
 *   unavailable: number}>} Accepted position and unfinished-work counts.
 */
export async function processSearchIndexBatch(
  index,
  loadDocument,
  { limit = 20, signal, onProgress, loadMetadata } = {}
) {
  signal?.throwIfAborted();
  const jobs = await index.getPendingJobs(limit);
  signal?.throwIfAborted();
  for (const job of jobs) {
    signal?.throwIfAborted();
    const state = await index.getJobState(job, signal);
    signal?.throwIfAborted();
    if (!state) {
      continue;
    }
    if (loadMetadata) {
      const metadata = await loadSearchText(
        index,
        job,
        () => loadMetadata(job, state, signal),
        signal
      );
      if (metadata && (await index.refreshJob(job, metadata, signal))) {
        onProgress?.(await index.getProgress());
        continue;
      }
    }
    const document = await loadSearchText(
      index,
      job,
      () => loadDocument(job, state, signal),
      signal
    );
    signal?.throwIfAborted();
    if (document) {
      await index.finishJob(job, document, signal);
    } else {
      await index.markUnavailable(job);
    }
    onProgress?.(await index.getProgress());
  }
  return index.getProgress();
}

/**
 * Quarantines a per-message loader failure before rethrowing the original error.
 * Storage and resolver operations stay outside this loader-only catch.
 *
 * @param {PanoramaSearchIndex} index - Open sidecar.
 * @param {SearchIndexJob} job - Exact attempted work.
 * @param {function(): (?SearchDocument|Promise<?SearchDocument>)} load - Text loader.
 * @param {AbortSignal} [signal] - Cancellation, which leaves work pending.
 * @returns {Promise<?SearchDocument>} Loaded text.
 */
async function loadSearchText(index, job, load, signal) {
  try {
    return await load();
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    try {
      await index.markUnavailable(job);
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        "Message load and unavailable status write failed"
      );
    }
    throw error;
  }
}
