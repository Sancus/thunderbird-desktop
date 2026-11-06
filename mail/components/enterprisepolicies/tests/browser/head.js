/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );

PoliciesPrefTracker.start();

async function setupPolicyEngineWithJson(json, customSchema) {
  PoliciesPrefTracker.restoreDefaultValues();
  if (typeof json != "object") {
    const filePath = getTestFilePath(json ? json : "non-existing-file.json");
    return EnterprisePolicyTesting.setupPolicyEngineWithJson(
      filePath,
      customSchema
    );
  }
  return EnterprisePolicyTesting.setupPolicyEngineWithJson(json, customSchema);
}

function checkLockedPref(prefName, prefValue) {
  EnterprisePolicyTesting.checkPolicyPref(prefName, prefValue, true);
}

function checkUnlockedPref(prefName, prefValue) {
  EnterprisePolicyTesting.checkPolicyPref(prefName, prefValue, false);
}

async function withNewTab(options, taskFn) {
  const expectedURI = Services.io.newURI(options.url);
  let pageLoaded;
  const tab = window.openTab("contentTab", {
    url: options.url,
    duplicate: true,
    onListener(browser) {
      pageLoaded = BrowserTestUtils.browserLoaded(browser, {
        // Preferences selects a category fragment before its load event.
        wantLoad: url =>
          Services.io.newURI(url).specIgnoringRef ==
          expectedURI.specIgnoringRef,
      });
    },
  });
  try {
    await pageLoaded;
    return await taskFn(tab.browser);
  } finally {
    document.getElementById("tabmail").closeTab(tab);
  }
}

add_setup(async function policies_headjs_startWithCleanSlate() {
  if (Services.policies.status != Ci.nsIEnterprisePolicies.INACTIVE) {
    await setupPolicyEngineWithJson("");
  }
  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.INACTIVE,
    "Engine is inactive at the start of the test"
  );
});

registerCleanupFunction(async function policies_headjs_finishWithCleanSlate() {
  if (Services.policies.status != Ci.nsIEnterprisePolicies.INACTIVE) {
    await setupPolicyEngineWithJson("");
  }
  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.INACTIVE,
    "Engine is inactive at the end of the test"
  );

  EnterprisePolicyTesting.resetRunOnceState();
  PoliciesPrefTracker.stop();
});

function waitForAddonInstall(addon_id) {
  return new Promise(resolve => {
    const listener = {
      onInstallEnded(install, addon) {
        if (addon.id == addon_id) {
          AddonManager.removeInstallListener(listener);
          resolve();
        }
      },
      onDownloadFailed() {
        AddonManager.removeInstallListener(listener);
        resolve();
      },
      onInstallFailed() {
        AddonManager.removeInstallListener(listener);
        resolve();
      },
    };
    AddonManager.addInstallListener(listener);
  });
}

function waitForAddonUninstall(addon_id) {
  return new Promise(resolve => {
    const listener = {};
    listener.onUninstalled = addon => {
      if (addon.id == addon_id) {
        AddonManager.removeAddonListener(listener);
        resolve();
      }
    };
    AddonManager.addAddonListener(listener);
  });
}
