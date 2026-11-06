/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// These are the two concrete search domains, not a participant registry. Native
// code alone selects roots, fences admission, grants Held, and releases the lock.
const domains = new Map([
  [
    "mail-search",
    { owners: new Set(), pending: new Set(), initialHistory: null },
  ],
  [
    "chat-search",
    { owners: new Set(), pending: new Set(), initialHistory: null },
  ],
]);
const workRecords = new WeakMap();
const holds = new WeakMap();
const failures = [];
const deliveryCancellations = new WeakMap();
let activeHold = null;

/**
 * @param {string} domain - Exact native search domain.
 * @returns {object} Concrete domain state.
 */
function domainState(domain) {
  const state = domains.get(domain);
  if (!state) {
    throw Components.Exception(
      "Unknown search writer domain",
      Cr.NS_ERROR_INVALID_ARG
    );
  }
  state.terminals ??= new Set();
  return state;
}

/** @returns {nsIObserver} The real native lease service; absence fails closed. */
function nativeGate() {
  return Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIObserver
  );
}

/**
 * Checks admission synchronously, before accounts, logger, or storage access.
 * Success is neither an operation ticket nor proof of selected-profile Held.
 *
 * @param {"mail-search"|"chat-search"} domain - Exact fixed native domain.
 */
export function checkSearchWriterAdmission(domain) {
  const state = domainState(domain);
  const gate = nativeGate();
  const bag = gate.QueryInterface(Ci.nsIPropertyBag2);
  state.initialHistory ??= bag.getPropertyAsUint32("writer-history." + domain);
  const subject = bag.getPropertyAsInterface(
    "writer-admission-subject",
    Ci.nsISupports
  );
  if (!subject) {
    throw Components.Exception(
      "Missing native writer subject",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  gate.observe(subject, "check-writer-admission", domain);
}

/**
 * Keeps original errors in observation order, including failures hidden by an
 * ordinary queue's recovery tail. No error is converted to a success or wrapper.
 *
 * @param {string} domain - Exact search domain.
 * @param {unknown} error - Original rejection or native exception.
 */
export function recordSearchWriterFailure(domain, error) {
  domainState(domain);
  if (
    !failures.some(entry => entry.domain === domain && entry.error === error)
  ) {
    failures.push({ domain, error });
  }
  if (activeHold && !activeHold.errors.includes(error)) {
    activeHold.errors.push(error);
  }
}

/**
 * @param {object} hold - Retained native view and concrete work.
 */
function validate(hold) {
  if (hold) {
    nativeGate().observe(hold.view, "validate-selected-view", "after-await");
  }
}

/**
 * Registers work in the same main-thread turn as admission, before invoking the
 * callback. Only a still-running, same-domain operation can own a continuation.
 * The opaque token has no native authority and cannot grant Held or release.
 *
 * @param {string} domain - Exact fixed domain.
 * @param {function(object): *} operation - Concrete operation, invoked immediately.
 * @param {?object} [parent=null] - Opaque token from a still-pending operation.
 * @param {?SearchWriter} [owner=null] - Concrete storage/observer owner.
 * @returns {*} Original synchronous value or actual asynchronous settlement.
 */
function run(domain, operation, parent = null, owner = null) {
  const state = domainState(domain);
  let inherited = null;
  if (parent !== null) {
    inherited = workRecords.get(parent);
    if (!inherited?.pending || inherited.domain !== domain) {
      throw Components.Exception(
        "Search continuation lost its owner",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    validate(inherited.hold);
  } else {
    checkSearchWriterAdmission(domain);
  }
  const token = Object.freeze({});
  let settle;
  const record = {
    domain,
    owner,
    pending: true,
    hold: inherited?.hold ?? owner?.hold ?? null,
    terminal: new Promise(resolve => {
      settle = resolve;
    }),
  };
  workRecords.set(token, record);
  state.pending.add(record);
  const finish = () => {
    record.pending = false;
    state.pending.delete(record);
    settle();
  };
  try {
    validate(record.hold);
    const result = operation(token);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(
        value => {
          try {
            validate(record.hold);
            return value;
          } catch (error) {
            recordSearchWriterFailure(domain, error);
            throw error;
          } finally {
            finish();
          }
        },
        error => {
          recordSearchWriterFailure(domain, error);
          try {
            validate(record.hold);
          } catch (later) {
            recordSearchWriterFailure(domain, later);
          }
          finish();
          throw error;
        }
      );
    }
    validate(record.hold);
    finish();
    return result;
  } catch (error) {
    recordSearchWriterFailure(domain, error);
    finish();
    throw error;
  }
}

/**
 * Captures an existing synchronous factory entry without changing its throw ABI.
 *
 * @param {string} domain - Exact search domain.
 * @param {function(object): *} operation - Actual synchronous factory body.
 * @returns {*} Original factory value or tracked asynchronous settlement.
 */
export function runSearchWriterOperation(domain, operation) {
  return run(domain, operation);
}

/**
 * Captures an unfinished open before its first logger/database lookup.
 *
 * @param {string} domain - Exact search domain.
 * @param {function(object): Promise<*>} operation - Actual open and failed-open cleanup.
 * @param {?object} [parent=null] - Existing same-domain operation, when nested.
 * @returns {Promise<*>} Original open result, including actual cleanup settlement.
 */
export function openSearchWriter(domain, operation, parent = null) {
  try {
    return Promise.resolve(run(domain, operation, parent));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Validates an actual still-pending factory/open continuation after an await.
 *
 * @param {object} work - Opaque token supplied to the captured operation.
 */
export function checkSearchWriterWork(work) {
  const record = workRecords.get(work);
  if (!record?.pending) {
    throw Components.Exception(
      "Search work has settled",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  validate(record.hold);
}

/**
 * Joins a concrete factory step and validates its retained native identity.
 *
 * @param {object} work - Pending factory/open token.
 * @param {function(): *} operation - Actual existing asynchronous step.
 * @returns {Promise<*>} Original result, or first rejection after settlement.
 */
export async function waitForSearchWriter(work, operation) {
  checkSearchWriterWork(work);
  let failed = false;
  let first;
  let result;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    first = error;
  }
  try {
    checkSearchWriterWork(work);
  } catch (error) {
    const record = workRecords.get(work);
    if (failed) {
      recordSearchWriterFailure(record.domain, first);
    }
    recordSearchWriterFailure(record.domain, error);
    if (!failed) {
      failed = true;
      first = error;
    }
  }
  if (failed) {
    throw first;
  }
  return result;
}

/**
 * Concrete search service/provider/observer lifetime. Its callbacks are private
 * closures over that instance; callers cannot register arbitrary native domains.
 */
export class SearchWriter {
  #domain;
  #stop;
  #close;
  #closed = null;
  #settled = false;
  #delivery = new AbortController();
  #state;
  #isTerminal;
  #resolveOwnership;
  #ownership = new Promise(resolve => {
    this.#resolveOwnership = resolve;
  });
  /** @type {?object} Exact selected native view, assigned only by native drain. */
  hold = null;

  /**
   * @param {string} domain - Mail-search or chat-search.
   * @param {function(): void} stop - Detach notifications and cancel only unlaunched scheduling.
   * @param {function(): Promise<void>} close - Actual normal instance close.
   * @param {function(): boolean} isTerminal - Actual storage/notification settlement receipt.
   * @param {?object} [parent=null] - Captured open operation, if constructed during open.
   */
  constructor(domain, stop, close, isTerminal, parent = null) {
    this.#domain = domain;
    this.#state = domainState(domain);
    this.#stop = stop;
    this.#close = close;
    this.#isTerminal = isTerminal;
    run(
      domain,
      token => {
        this.hold = workRecords.get(token).hold;
        this.#state.owners.add(this);
        this.hold?.owners.add(this);
      },
      parent
    );
  }

  /** @returns {Promise<void>} Resolves only after actual owned resources settle. */
  get settlement() {
    return this.#ownership;
  }

  /** @returns {boolean} Whether real ownership settled, even after a logical error. */
  get terminal() {
    return this.#isTerminal();
  }

  /** @returns {AbortSignal} Cancels delivery, without cancelling owned writes. */
  get deliverySignal() {
    return this.#delivery.signal;
  }

  /** @returns {boolean} Whether this owner's actual close succeeded. */
  get closed() {
    return this.#settled;
  }

  /**
   * Drops only JS custody after the native caller has settled this generation.
   * It does not release the native lock or reset native admission/history.
   *
   * @param {object} hold - This owner's identical retained generation.
   */
  release(hold) {
    if (this.hold !== hold || !this.#isTerminal()) {
      throw Components.Exception(
        "Search storage has not closed",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    this.hold = null;
  }

  /**
   * @param {function(object): *} operation - Concrete method body.
   * @param {?object} [parent=null] - Pending same-domain caller's token.
   * @returns {*} Original synchronous value or tracked promise.
   */
  run(operation, parent = null) {
    return run(this.#domain, operation, parent, this);
  }

  /**
   * Checks retained native parent/generation/roots around each asynchronous step.
   * The thunk is not launched when a pre-step identity check already fails.
   *
   * @param {function(): *} operation - Actual asynchronous step.
   * @returns {Promise<*>} Its original result or first failure after settlement.
   */
  async wait(operation) {
    validate(this.hold);
    return this.settle(operation);
  }

  /**
   * Joins actual cleanup even after a validation failure. This does not admit any
   * new work; only the private owner's existing close path calls this method.
   *
   * @param {function(): *} operation - Already-owned cleanup or validated step.
   * @returns {Promise<*>} Actual result, retaining the first error.
   */
  async settle(operation) {
    let value;
    let failed = false;
    let first;
    try {
      value = await operation();
    } catch (error) {
      failed = true;
      first = error;
    }
    try {
      validate(this.hold);
    } catch (error) {
      if (failed) {
        recordSearchWriterFailure(this.#domain, first);
      }
      recordSearchWriterFailure(this.#domain, error);
      if (!failed) {
        failed = true;
        first = error;
      }
    }
    if (failed) {
      throw first;
    }
    return value;
  }

  /** Checks the retained native identity before a synchronous resolver step. */
  check() {
    validate(this.hold);
  }

  /** Detaches only this instance's notifications and not-yet-launched timers. */
  stop() {
    this.#stop();
    if (!this.#delivery.signal.aborted) {
      const error = Components.Exception(
        "Search delivery stopped for migration",
        Cr.NS_BINDING_ABORTED
      );
      deliveryCancellations.set(error, this);
      this.#delivery.abort(error);
    }
  }

  /**
   * Retains the real close promise and all already-registered operations.
   * A close rejection never discards its owner or pretends storage is closed.
   *
   * @param {function(): Promise<void>} operation - Original instance close body.
   * @returns {Promise<void>} Same concrete close settlement on every call.
   */
  finish(operation) {
    if (!this.#closed) {
      let resolveClose;
      let rejectClose;
      this.#closed = new Promise((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      const pending = [...this.#state.pending].filter(
        record => record.owner === this
      );
      let actual;
      try {
        actual = Promise.resolve(operation());
      } catch (error) {
        actual = Promise.reject(error);
      }
      (async () => {
        const [closed] = await Promise.all([
          Promise.allSettled([actual]),
          Promise.all(pending.map(record => record.terminal)),
        ]);
        if (this.#isTerminal()) {
          this.#resolveOwnership();
          this.#state.terminals.add(this.#ownership);
          this.#state.owners.delete(this);
        }
        if (closed[0].status === "rejected") {
          recordSearchWriterFailure(this.#domain, closed[0].reason);
          throw closed[0].reason;
        }
        validate(this.hold);
        if (!this.#isTerminal()) {
          const error = Components.Exception(
            "Search close has no actual terminal receipt",
            Cr.NS_ERROR_NOT_AVAILABLE
          );
          recordSearchWriterFailure(this.#domain, error);
          throw error;
        }
        this.#settled = true;
      })().then(resolveClose, rejectClose);
    }
    return this.#closed;
  }

  /** @returns {Promise<void>} Actual existing close, without fresh admission. */
  close() {
    return this.#close();
  }
}

/**
 * Native calls this after its synchronous admission fence. Capture, joins and
 * storage closes run on the same JS target as registration. Failed work remains
 * a failure after all other captured work and cleanup actually settle.
 *
 * @param {nsISupports} nativeView - Real native selected-profile lease view.
 * @returns {Promise<void>} Same drain promise for that exact view.
 */
export function drainSearchMigrationWriters(nativeView) {
  try {
    nativeGate().observe(nativeView, "validate-selected-view", "after-await");
    const previous = holds.get(nativeView);
    if (previous) {
      return previous.drain;
    }
    if (activeHold) {
      throw Components.Exception(
        "Another search generation is retained",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    const hold = {
      view: nativeView,
      owners: new Set(),
      terminals: new Set(),
      errors: [...new Set(failures.map(entry => entry.error))],
      deliveryCancellations: [],
      drain: null,
      release: null,
    };
    activeHold = hold;
    holds.set(nativeView, hold);
    const capture = () => {
      for (const [domain, state] of domains) {
        try {
          if (state.initialHistory === null) {
            state.initialHistory = nativeGate()
              .QueryInterface(Ci.nsIPropertyBag2)
              .getPropertyAsUint32("writer-history." + domain);
          }
          // Started before capture was installed is not proof of empty writers.
          if (state.initialHistory !== 0) {
            state.historyFailure ??= Components.Exception(
              "Uncaptured search writer history",
              Cr.NS_ERROR_NOT_AVAILABLE
            );
            recordSearchWriterFailure(domain, state.historyFailure);
            // No original operation owner exists from which to obtain a real
            // terminal. Preserve the uncertainty instead of certifying it.
            state.unknownOwnership ??= new Promise(() => {});
          }
        } catch (error) {
          // A failed gate/history read is a failure, never permission to skip
          // already-captured I/O or sibling storage cleanup.
          recordSearchWriterFailure(domain, error);
          state.unknownOwnership ??= new Promise(() => {});
        }
        if (state.unknownOwnership) {
          hold.terminals.add(state.unknownOwnership);
        }
        for (const terminal of state.terminals ?? []) {
          hold.terminals.add(terminal);
        }
        for (const record of state.pending) {
          record.hold = hold;
        }
        for (const owner of state.owners) {
          owner.hold = hold;
          hold.owners.add(owner);
          try {
            owner.stop();
          } catch (error) {
            recordSearchWriterFailure(domain, error);
          }
        }
      }
    };
    let resolveDrain;
    let rejectDrain;
    hold.drain = new Promise((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    (async () => {
      for (;;) {
        capture();
        const pending = [...domains.values()].flatMap(state => [
          ...state.pending,
        ]);
        if (!pending.length) {
          break;
        }
        await Promise.all(pending.map(record => record.terminal));
        try {
          validate(hold);
        } catch (error) {
          if (!hold.errors.includes(error)) {
            hold.errors.push(error);
          }
        }
      }
      // Close every captured owner, including siblings after the first failure.
      const results = await Promise.allSettled(
        [...hold.owners].map(owner =>
          Promise.resolve().then(() => owner.close())
        )
      );
      for (const result of results) {
        if (
          result.status === "rejected" &&
          !hold.errors.includes(result.reason)
        ) {
          hold.errors.push(result.reason);
        }
      }
      // A rejected close can mean asyncClose never launched. Keep custody and
      // Draining until its actual ownership receipt settles; rejection alone
      // must not certify a safe-terminal domain to the native parent.
      await Promise.all([
        ...hold.terminals,
        ...[...hold.owners].map(owner => owner.settlement),
      ]);
      try {
        validate(hold);
      } catch (error) {
        if (!hold.errors.includes(error)) {
          hold.errors.push(error);
        }
      }
      if (hold.errors.length) {
        throw hold.errors[0];
      }
    })().then(resolveDrain, rejectDrain);
    return hold.drain;
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Native invokes this only after the selected consumer settles. Cleanup cannot
 * reset native history or release roots; the native parent owns that transition.
 *
 * @param {nsISupports} nativeView - The identical retained native lease view.
 * @param {number} settlementNsresult - Native first consumer result, unchanged.
 * @returns {Promise<void>} Idempotent cleanup settlement for this view.
 */
export function releaseSearchMigrationWriters(nativeView, settlementNsresult) {
  try {
    const hold = holds.get(nativeView);
    if (
      !hold ||
      !Number.isInteger(settlementNsresult) ||
      settlementNsresult < 0 ||
      settlementNsresult > 0xffffffff
    ) {
      throw Components.Exception(
        "Search release lost its retained generation",
        Cr.NS_ERROR_INVALID_ARG
      );
    }
    if (hold.release) {
      if (hold.settlementNsresult !== settlementNsresult) {
        throw Components.Exception(
          "Search release changed its original settlement",
          Cr.NS_ERROR_INVALID_ARG
        );
      }
      return hold.release;
    }
    if (activeHold !== hold) {
      throw Components.Exception(
        "Search release lost its retained generation",
        Cr.NS_ERROR_INVALID_ARG
      );
    }
    hold.settlementNsresult = settlementNsresult;
    hold.release = (async () => {
      // Do not skip owned cleanup because drain rejected or cancellation arrived.
      await Promise.allSettled([hold.drain]);
      const results = await Promise.allSettled(
        [...hold.owners].map(owner =>
          Promise.resolve().then(() => owner.close())
        )
      );
      validate(hold);
      for (const result of results) {
        if (
          result.status === "rejected" &&
          !hold.errors.includes(result.reason)
        ) {
          hold.errors.push(result.reason);
        }
      }
      await Promise.all([...hold.owners].map(owner => owner.settlement));
      validate(hold);
      for (const owner of hold.owners) {
        owner.release(hold);
      }
      hold.owners.clear();
      for (const state of domains.values()) {
        state.terminals?.clear();
      }
      activeHold = null;
      failures.length = 0;
    })();
    return hold.release;
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Diagnostic originals for the native parent; this never grants authority.
 *
 * @param {nsISupports} nativeView - Exact retained view.
 * @returns {unknown[]} First failure and actual secondary failures in order.
 */
export function getSearchMigrationErrors(nativeView) {
  const hold = holds.get(nativeView);
  if (!hold) {
    throw Components.Exception(
      "Unknown search generation",
      Cr.NS_ERROR_INVALID_ARG
    );
  }
  return [...hold.errors];
}
