# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

from marionette_harness import MarionetteTestCase


class TestLegacyChatSearch(MarionetteTestCase):
    def test_restart_preserves_physical_log_identity(self):
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        previous_prefs = self.marionette.execute_script(
            """
            return [
              "mailnews.database.global.indexer.enabled",
              "purple.logging.log_chats",
            ].map(name => [name, Services.prefs.prefHasUserValue(name)
              ? Services.prefs.getBoolPref(name) : null]);
            """
        )
        try:
            self.marionette.set_pref("mailnews.database.global.indexer.enabled", True)
            self.marionette.set_pref("purple.logging.log_chats", True)
            self.marionette.timeout.script = 60
            before = self.marionette.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                (async () => {
                  const { GlodaIMSearcher } = ChromeUtils.importESModule(
                    "resource:///modules/GlodaIMSearcher.sys.mjs"
                  );
                  const { GlodaIndexer, IndexingJob } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/GlodaIndexer.sys.mjs"
                  );
                  const { GlodaConstants } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/GlodaConstants.sys.mjs"
                  );
                  const { getLogWriter, closeLogWriter } = ChromeUtils.importESModule(
                    "resource:///modules/logger.sys.mjs"
                  );
                  const start = Date.UTC(2022, 2, 4, 12);
                  const conversation = {
                    id: 214080,
                    name: "restart-room",
                    normalizedName: "restart-room",
                    title: "Restart room",
                    startDate: start * 1000,
                    isChat: true,
                    account: {
                      name: "legacy-restart-account",
                      normalizedName: "legacy-restart-account",
                      protocol: { normalizedName: "mochitest", id: "prpl-mochitest" },
                    },
                  };
                  const writer = getLogWriter(conversation);
                  await writer.logMessage({
                    time: start / 1000 + 1,
                    who: "RestartSpeaker",
                    displayMessage: "restartedlegacyneedle café 東京検索",
                    incoming: true,
                  });
                  const path = writer.currentPath;
                  closeLogWriter(conversation);
                  await new Promise(resolve => {
                    GlodaIndexer.indexJob(new IndexingJob("logsFolderSweep", null));
                    const listener = status => {
                      if (status == GlodaConstants.kIndexerIdle) {
                        GlodaIndexer.removeListener(listener);
                        resolve();
                      }
                    };
                    GlodaIndexer.addListener(listener);
                  });
                  const items = await new Promise(resolve => {
                    new GlodaIMSearcher(null, "restartedlegacyneedle").getCollection({
                      onItemsAdded() {},
                      onItemsModified() {},
                      onItemsRemoved() {},
                      onQueryCompleted(collection) { resolve(collection.items); },
                    });
                  });
                  return {
                    pid: Services.appinfo.processID,
                    native: Services.prefs.getBoolPref("mail.panorama.enabled", false),
                    backend: Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
                      .contractIDToCID("@mozilla.org/msgDatabase/msgDBService;1").toString(),
                    path: PathUtils.split(path).slice(-4).join("/"),
                    items: items.map(item => [item.path, item.id, item.content]),
                  };
                })().then(done, error => done({ error: String(error) }));
                """
            )
            self.assertNotIn("error", before)
            self.assertFalse(before["native"])
            self.assertEqual(before["backend"], "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}")
            self.assertEqual(len(before["items"]), 1)
            self.assertEqual(before["items"][0][0], before["path"])
            self.assertIn("RestartSpeaker: restartedlegacyneedle café 東京検索", before["items"][0][2])

            # Quit normally so the actual Gloda database and IM index cache settle.
            self.marionette.quit(in_app=True)
            self.marionette.start_session()
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.timeout.script = 60
            after = self.marionette.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                (async () => {
                  const { GlodaIMSearcher } = ChromeUtils.importESModule(
                    "resource:///modules/GlodaIMSearcher.sys.mjs"
                  );
                  const { GlodaIndexer, IndexingJob } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/GlodaIndexer.sys.mjs"
                  );
                  const { GlodaConstants } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/GlodaConstants.sys.mjs"
                  );
                  const cache = await IOUtils.readJSON(PathUtils.join(
                    PathUtils.profileDir, "logs", "indexedFiles.json"
                  ));
                  await new Promise(resolve => {
                    GlodaIndexer.indexJob(new IndexingJob("logsFolderSweep", null));
                    const listener = status => {
                      if (status == GlodaConstants.kIndexerIdle) {
                        GlodaIndexer.removeListener(listener);
                        resolve();
                      }
                    };
                    GlodaIndexer.addListener(listener);
                  });
                  const items = await new Promise(resolve => {
                    new GlodaIMSearcher(null, "restartedlegacyneedle").getCollection({
                      onItemsAdded() {},
                      onItemsModified() {},
                      onItemsRemoved() {},
                      onQueryCompleted(collection) { resolve(collection.items); },
                    });
                  });
                  return {
                    pid: Services.appinfo.processID,
                    native: Services.prefs.getBoolPref("mail.panorama.enabled", false),
                    backend: Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
                      .contractIDToCID("@mozilla.org/msgDatabase/msgDBService;1").toString(),
                    cache: cache.knownFiles.mochitest["legacy-restart-account"]["restart-room.chat"],
                    items: items.map(item => [item.path, item.id, item.content]),
                  };
                })().then(done, error => done({ error: String(error) }));
                """
            )
            self.assertNotIn("error", after)
            self.assertNotEqual(after["pid"], before["pid"])
            self.assertFalse(after["native"])
            self.assertEqual(after["backend"], before["backend"])
            self.assertEqual(after["items"], before["items"])
            self.assertEqual(list(after["cache"]), [before["path"].split("/")[-1]])
        finally:
            if not self.marionette.session:
                self.marionette.start_session()
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            for name, value in previous_prefs:
                self.marionette.set_pref(name, value)
