/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { PgpSqliteDb2 } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/sqliteDb.sys.mjs"
);

const FINGERPRINT = "0123456789abcdef0123456789abcdef01234567";

add_setup(async function () {
  do_get_profile();
  await PgpSqliteDb2.checkDatabaseStructure();
  registerCleanupFunction(() => PgpSqliteDb2.deleteAcceptance(FINGERPRINT));
});

/**
 * Checks that a personal-key operation waits for its database operation.
 *
 * @param {string} method - The personal-key API to call.
 * @param {string} delegate - The database operation used by the API.
 * @param {Array} args - The expected database operation arguments.
 * @returns {Promise<void>} Resolves after the completion checks finish.
 */
async function checkCompletion(method, delegate, args) {
  const original = Object.getOwnPropertyDescriptor(PgpSqliteDb2, delegate);
  const finished = Promise.withResolvers();
  let settled = false;
  let operation;
  PgpSqliteDb2[delegate] = (...actual) => {
    Assert.deepEqual(actual, args, "The API forwards its database arguments");
    return finished.promise;
  };
  try {
    operation = PgpSqliteDb2[method](FINGERPRINT).then(() => {
      settled = true;
    });
    await Promise.resolve();
    Assert.ok(!settled, "The API stays pending until the database finishes");
    finished.resolve();
    await operation;
    Assert.ok(settled, "The API resolves after the database finishes");
  } finally {
    finished.resolve();
    try {
      await operation;
    } finally {
      Object.defineProperty(PgpSqliteDb2, delegate, original);
    }
  }
}

/**
 * Checks that a personal-key operation rejects with its database failure.
 *
 * @param {string} method - The personal-key API to call.
 * @param {string} delegate - The database operation used by the API.
 * @returns {Promise<void>} Resolves after the rejection check finishes.
 */
async function checkFailure(method, delegate) {
  const original = Object.getOwnPropertyDescriptor(PgpSqliteDb2, delegate);
  const error = new Error("controlled database failure");
  const failed = Promise.reject(error);
  // Handle the controlled delegate rejection even when testing the broken API.
  failed.catch(() => {});
  PgpSqliteDb2[delegate] = () => failed;
  try {
    await Assert.rejects(
      PgpSqliteDb2[method](FINGERPRINT),
      actual => actual === error,
      "The API propagates the original database failure"
    );
  } finally {
    Object.defineProperty(PgpSqliteDb2, delegate, original);
  }
}

add_task(async function test_acceptAsPersonalKeyWaitsForWrite() {
  await checkCompletion("acceptAsPersonalKey", "updateAcceptance", [
    FINGERPRINT,
    null,
    "personal",
  ]);
});

add_task(async function test_deletePersonalKeyAcceptanceWaitsForWrite() {
  await checkCompletion("deletePersonalKeyAcceptance", "deleteAcceptance", [
    FINGERPRINT,
  ]);
});

add_task(async function test_acceptAsPersonalKeyPropagatesFailure() {
  await checkFailure("acceptAsPersonalKey", "updateAcceptance");
});

add_task(async function test_deletePersonalKeyAcceptancePropagatesFailure() {
  await checkFailure("deletePersonalKeyAcceptance", "deleteAcceptance");
});

add_task(async function test_personalKeyAcceptanceRoundTrip() {
  Assert.ok(
    !(await PgpSqliteDb2.isAcceptedAsPersonalKey(FINGERPRINT)),
    "The fresh database has no personal-key acceptance"
  );
  await PgpSqliteDb2.acceptAsPersonalKey(FINGERPRINT);
  Assert.ok(
    await PgpSqliteDb2.isAcceptedAsPersonalKey(FINGERPRINT),
    "Awaiting acceptance makes the stored personal-key decision readable"
  );
  await PgpSqliteDb2.deletePersonalKeyAcceptance(FINGERPRINT);
  Assert.ok(
    !(await PgpSqliteDb2.isAcceptedAsPersonalKey(FINGERPRINT)),
    "Awaiting deletion removes the stored personal-key decision"
  );
});
