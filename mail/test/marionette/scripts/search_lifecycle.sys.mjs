/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { MailSearchService } from "resource:///modules/panorama/MailSearchService.sys.mjs";
import {
  closeMailSearch,
  getMailSearchService,
} from "resource:///modules/panorama/MailSearch.sys.mjs";
import { getMailSearchPolicy } from "resource:///modules/panorama/MailSearchPolicy.sys.mjs";

let activityState;
let quitState;

/**
 * Resolves only the supplied current physical header.
 *
 * @param {object} selection - Fixture folderURI, key and messageId.
 * @returns {nsIMsgDBHdr} Current fixture header.
 */
function headerFor(selection) {
  const folder = MailServices.folderLookup.getFolderForURL(selection.folderURI);
  const header = folder.msgDatabase.getMsgHdrForKey(selection.key);
  if (
    header.folder.URI != selection.folderURI ||
    header.messageId != selection.messageId
  ) {
    throw new Error("The lifecycle fixture changed physical identity");
  }
  return header;
}

/**
 * Reads native eligibility for the real preferences control's current value.
 *
 * @param {object} selection - Current fixture physical header.
 * @returns {object} Current native eligibility policy.
 */
export function policy(selection) {
  return getMailSearchPolicy(headerFor(selection));
}

/**
 * Observes real unavailable background work in the shared native service.
 * Restores the fixture token through finishActivity, including on failure.
 *
 * @param {object} selection - Current owned stored message.
 * @returns {Promise<object>} Native progress, text and owned activity state.
 */
export async function observeActivity(selection) {
  await closeMailSearch();
  const header = headerFor(selection);
  if (header.storeToken == "1") {
    throw new Error("The fixture needs its original stored body token");
  }
  activityState = { header, token: header.storeToken };
  header.storeToken = "1";
  const service = await getMailSearchService();
  const state = activityState;
  state.service = service;
  state.onProgress = service.onProgress;
  state.onError = service.onError;
  state.errors = [];
  const settled = Promise.withResolvers();
  service.onError = error => state.errors.push(String(error));
  service.onProgress = progress => {
    if (!progress.moreWork && progress.unavailable) {
      settled.resolve(progress);
    }
  };
  const progress = await settled.promise;
  const manager = Cc["@mozilla.org/activity-manager;1"].getService(
    Ci.nsIActivityManager
  );
  const activities = manager.getProcessesByContext(
    "panorama-search",
    progress.sourceId
  );
  state.manager = manager;
  state.sourceId = progress.sourceId;
  state.activity = activities[0];
  return {
    sourceId: progress.sourceId,
    unavailable: progress.unavailable,
    text: await service.getText(String(header.messageKey)),
    activityCount: activities.length,
    waiting:
      state.activity?.state == Ci.nsIActivityProcess.STATE_WAITINGFORRETRY,
    percent: state.activity?.percentComplete,
    status: state.activity?.lastStatusText,
    errors: state.errors,
    physical: {
      folderURI: header.folder.URI,
      key: header.messageKey,
      messageId: header.messageId,
    },
  };
}

/**
 * Restores the owned body token and drains only this default service.
 *
 * @returns {Promise<object>} Activity cancellation and removal results.
 */
export async function finishActivity() {
  const state = activityState;
  if (!state) {
    return null;
  }
  state.header.storeToken = state.token;
  if (state.service) {
    state.service.onProgress = state.onProgress;
    state.service.onError = state.onError;
  }
  await closeMailSearch();
  const result = {
    tokenRestored: state.header.storeToken == state.token,
    cancelled: state.activity?.state == Ci.nsIActivityProcess.STATE_CANCELED,
    remaining: state.manager?.getProcessesByContext(
      "panorama-search",
      state.sourceId
    ).length,
  };
  activityState = null;
  return result;
}

/**
 * Holds real native service delivery while two default-factory callers wait.
 * The actual quit observer releases delivery; production owns the drain.
 * A profile blocker writes the results before the process exits normally.
 *
 * @param {string} receiptName - Test-owned filename in the current profile.
 * @returns {Promise<object>} Actual pending-call counts and receipt path.
 */
export async function armQuit(receiptName) {
  if (quitState || receiptName != PathUtils.filename(receiptName)) {
    throw new Error("A unique profile lifecycle receipt is required");
  }
  await closeMailSearch();
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIDatabaseCore
  );
  const state = (quitState = {
    originalOpen: MailSearchService.open,
    release: Promise.withResolvers(),
    entered: Promise.withResolvers(),
    closeEntered: Promise.withResolvers(),
    receiptPath: PathUtils.join(PathUtils.profileDir, receiptName),
    record: {
      sourceId: core.sourceId,
      opens: 0,
      callbacks: [0, 0],
      sameService: [],
      errors: [],
      quitObserved: 0,
      profileObserved: 0,
      closePromisesSame: true,
    },
  });
  state.open = async function (...args) {
    state.record.opens++;
    let service;
    try {
      service = await state.originalOpen.apply(this, args);
    } catch (error) {
      state.entered.reject(error);
      throw error;
    }
    state.service = service;
    state.originalClose = service.close;
    state.close = function (...closeArgs) {
      const promise = state.originalClose.apply(this, closeArgs);
      state.record.closePromisesSame &&=
        !state.closePromise || promise == state.closePromise;
      state.closePromise = promise;
      state.closeEntered.resolve();
      return promise;
    };
    service.close = state.close;
    state.entered.resolve();
    await state.release.promise;
    return service;
  };
  MailSearchService.open = state.open;
  state.pending = [0, 1].map(index =>
    getMailSearchService().then(
      service => {
        state.record.callbacks[index]++;
        state.record.sameService[index] = service == state.service;
      },
      error => {
        state.record.callbacks[index]++;
        state.record.errors.push(String(error));
      }
    )
  );
  state.observer = () => {
    state.record.quitObserved++;
    state.record.pendingAtQuit = state.record.callbacks.every(
      count => count == 0
    );
    state.release.resolve();
  };
  Services.obs.addObserver(state.observer, "quit-application-granted");
  state.blocker = async () => {
    try {
      state.record.profileObserved++;
      state.record.shuttingDown = Services.startup.shuttingDown;
      state.record.lateRejected = [];
      for (let index = 0; index < 2; index++) {
        try {
          await getMailSearchService();
          state.record.lateRejected.push(false);
        } catch (error) {
          state.record.lateRejected.push(
            error.result == Cr.NS_ERROR_NOT_AVAILABLE
          );
        }
      }
      await Promise.all(state.pending);
      await state.closeEntered.promise;
      await state.closePromise;
      state.record.drained = true;
      try {
        await state.service.update();
        state.record.closedUpdateRejected = false;
      } catch (error) {
        state.record.closedUpdateRejected =
          error.message == "Mail search is closed";
      }
      const manager = Cc["@mozilla.org/activity-manager;1"].getService(
        Ci.nsIActivityManager
      );
      state.record.activities = manager.getProcessesByContext(
        "panorama-search",
        core.sourceId
      ).length;
    } catch (error) {
      state.record.error = String(error) + "\n" + error.stack;
    } finally {
      MailSearchService.open = state.originalOpen;
      if (state.service) {
        state.service.close = state.originalClose;
      }
      Services.obs.removeObserver(state.observer, "quit-application-granted");
      await IOUtils.writeJSON(state.receiptPath, state.record);
    }
  };
  AsyncShutdown.profileBeforeChange.addBlocker(
    "S422 native factory receipt",
    state.blocker
  );
  try {
    await state.entered.promise;
  } catch (error) {
    try {
      await cancelQuit();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Native quit preparation and cleanup failed"
      );
    }
    throw error;
  }
  return {
    opens: state.record.opens,
    callbacks: [...state.record.callbacks],
    sourceId: core.sourceId,
    receiptPath: state.receiptPath,
  };
}

/**
 * Releases an armed test that failed before requesting normal quit.
 *
 * @returns {Promise<void>} Resolves after normal default-service cleanup.
 */
export async function cancelQuit() {
  const state = quitState;
  if (!state) {
    return;
  }
  state.release.resolve();
  Services.obs.removeObserver(state.observer, "quit-application-granted");
  AsyncShutdown.profileBeforeChange.removeBlocker(state.blocker);
  await Promise.all(state.pending);
  MailSearchService.open = state.originalOpen;
  if (state.service) {
    state.service.close = state.originalClose;
  }
  await closeMailSearch();
  quitState = null;
}
