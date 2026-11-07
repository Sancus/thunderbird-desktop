/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

/**
 * Read the real URL's current running state.
 *
 * @param {nsIMsgMailNewsUrl} url - The URL to inspect.
 * @returns {boolean} Whether the URL is running.
 */
function isRunning(url) {
  const state = {};
  url.GetUrlState(state);
  return state.value;
}

add_task(async function testDetachedFolderTerminalUrl() {
  setupIMAPPump();
  const urls = [];
  registerCleanupFunction(() => {
    for (const { url } of urls) {
      if (isRunning(url)) {
        url.SetUrlState(false, Cr.NS_BINDING_ABORTED);
      }
    }
    teardownIMAPPump();
  });
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  const databaseService = Cc[
    "@mozilla.org/msgDatabase/msgDBService;1"
  ].getService(Ci.nsIMsgDBService);
  Assert.equal(
    "nsIDatabaseCore" in Ci && databaseService instanceof Ci.nsIDatabaseCore,
    native,
    "The ordinary manifest selected the actual database backend"
  );
  const storeContract = Services.prefs.getCharPref(
    "mail.serverDefaultStoreContractID"
  );
  Assert.equal(
    IMAPPump.incomingServer.msgStore.storeType,
    storeContract == "@mozilla.org/msgstore/maildirstore;1"
      ? "maildir"
      : "mbox",
    "The actual physical store matches the ordinary startup manifest"
  );
  const root = IMAPPump.incomingServer.rootFolder;
  const discovered = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(root, discovered, null);
  await discovered.promise;
  const folder = root.getChildNamed("INBOX");
  Assert.ok(folder);
  Assert.ok(folder.filePath.path, "The real folder has an initialized path");
  const sink = folder.QueryInterface(Ci.nsIImapMailFolderSink);

  function makeUrl() {
    const url = Services.io
      .newURI(folder.URI)
      .QueryInterface(Ci.nsIMsgMailNewsUrl);
    const events = [];
    url.RegisterListener({
      QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
      OnStartRunningUrl() {
        events.push("start");
      },
      OnStopRunningUrl(stoppedUrl, status) {
        Assert.equal(stoppedUrl.spec, url.spec);
        events.push(status);
      },
    });
    const item = { url, events };
    urls.push(item);
    return item;
  }

  const live = makeUrl();
  sink.setUrlState(null, live.url, true, false, Cr.NS_OK);
  Assert.ok(isRunning(live.url));
  sink.setUrlState(null, live.url, false, false, Cr.NS_OK);
  Assert.ok(!isRunning(live.url));
  Assert.deepEqual(live.events, ["start", Cr.NS_OK]);

  const completed = makeUrl();
  const failed = makeUrl();
  const suspended = makeUrl();
  const neverStarted = makeUrl();
  for (const item of [completed, failed, suspended]) {
    sink.setUrlState(null, item.url, true, false, Cr.NS_OK);
    Assert.ok(isRunning(item.url));
    Assert.deepEqual(item.events, ["start"]);
  }

  folder.Shutdown(false);
  sink.setUrlState(null, completed.url, false, false, Cr.NS_OK);
  Assert.ok(
    !isRunning(completed.url),
    "A detached folder retires its running URL"
  );
  Assert.deepEqual(completed.events, ["start", Cr.NS_OK]);
  sink.setUrlState(null, completed.url, false, false, Cr.NS_OK);
  Assert.deepEqual(completed.events, ["start", Cr.NS_OK]);

  sink.setUrlState(null, failed.url, false, false, Cr.NS_ERROR_FAILURE);
  Assert.ok(!isRunning(failed.url));
  Assert.deepEqual(failed.events, ["start", Cr.NS_ERROR_FAILURE]);

  sink.setUrlState(null, suspended.url, false, true, Cr.NS_OK);
  Assert.ok(isRunning(suspended.url), "A suspended URL remains pending");
  Assert.deepEqual(suspended.events, ["start"]);
  sink.setUrlState(null, suspended.url, false, false, Cr.NS_BINDING_ABORTED);
  Assert.ok(!isRunning(suspended.url));
  Assert.deepEqual(suspended.events, ["start", Cr.NS_BINDING_ABORTED]);

  sink.setUrlState(null, neverStarted.url, true, false, Cr.NS_OK);
  Assert.ok(
    !isRunning(neverStarted.url),
    "A closed folder cannot start a new URL"
  );
  sink.setUrlState(null, neverStarted.url, false, false, Cr.NS_OK);
  Assert.deepEqual(
    neverStarted.events,
    [],
    "No stop is delivered without a start"
  );
  sink.setUrlState(null, live.url, false, false, Cr.NS_ERROR_FAILURE);
  Assert.deepEqual(
    live.events,
    ["start", Cr.NS_OK],
    "A settled URL stays settled"
  );
  sink.setUrlState(null, null, false, false, Cr.NS_ERROR_FAILURE);
});
