/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

add_task(function testUnavailableTaskbarProgressIsOptional() {
  const { TaskbarProgress } = ChromeUtils.importESModule(
    "resource:///modules/TaskbarProgress.sys.mjs"
  );
  Assert.equal(TaskbarProgress.getTaskbarProgress({ docShell: null }), null);
  const cid = MockRegistrar.register("@mozilla.org/windows-taskbar;1", {
    QueryInterface: ChromeUtils.generateQI(["nsIWinTaskbar"]),
    available: true,
    getTaskbarProgress() {
      Components.returnCode = Cr.NS_ERROR_NOT_AVAILABLE;
      return null;
    },
  });
  try {
    Assert.equal(TaskbarProgress.getTaskbarProgress(window), null);
  } finally {
    MockRegistrar.unregister(cid);
  }
});

add_task(function testUnexpectedTaskbarProgressErrorIsPreserved() {
  const { TaskbarProgress } = ChromeUtils.importESModule(
    "resource:///modules/TaskbarProgress.sys.mjs"
  );
  const cid = MockRegistrar.register("@mozilla.org/windows-taskbar;1", {
    QueryInterface: ChromeUtils.generateQI(["nsIWinTaskbar"]),
    available: true,
    getTaskbarProgress() {
      Components.returnCode = Cr.NS_ERROR_FAILURE;
      return null;
    },
  });
  try {
    Assert.throws(
      () => TaskbarProgress.getTaskbarProgress(window),
      /NS_ERROR_FAILURE/
    );
  } finally {
    MockRegistrar.unregister(cid);
  }
});

add_task(function testUnavailableTaskbarIsNotQueried() {
  const { TaskbarProgress } = ChromeUtils.importESModule(
    "resource:///modules/TaskbarProgress.sys.mjs"
  );
  let queried = false;
  const cid = MockRegistrar.register("@mozilla.org/windows-taskbar;1", {
    QueryInterface: ChromeUtils.generateQI(["nsIWinTaskbar"]),
    available: false,
    getTaskbarProgress() {
      queried = true;
      return null;
    },
  });
  try {
    Assert.equal(TaskbarProgress.getTaskbarProgress(window), null);
    Assert.ok(!queried, "An unavailable taskbar is never asked for progress");
  } finally {
    MockRegistrar.unregister(cid);
  }
});
