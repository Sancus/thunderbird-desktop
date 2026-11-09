# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import json
import shutil
import tempfile
from pathlib import Path

from marionette_driver import Wait
from marionette_driver.addons import Addons
from marionette_harness import MarionetteTestCase

SCRIPT = (Path(__file__).parent / "scripts" / "fixed_profile.js").read_text(
    encoding="utf-8"
)
EXTENSION_PREFIX = "S711EXT "
EXTENSION_ID = "s711-fixed-profile@example.invalid"
EXTENSION_BACKGROUND = r"""
(async () => {
  const expected = __EXPECTED__;
  const report = [];
  for (const item of expected) {
    const page = await messenger.messages.query({
      headerMessageId: item.messageId,
    });
    const rows = [];
    for (const message of page.messages) {
      let raw = await messenger.messages.getRaw(message.id);
      if (typeof raw != "string") {
        raw = await raw.text();
      }
      rows.push({
        headerMessageId: message.headerMessageId,
        subject: message.subject,
        author: message.author,
        folderPath: message.folder?.path ?? null,
        hasBody: raw.includes(item.body),
      });
    }
    report.push({ messageId: item.messageId, rows });
  }
  console.log("__PREFIX__" + JSON.stringify(report));
})().catch(error =>
  console.log("__PREFIX__" + JSON.stringify({ error: String(error) }))
);
"""


class TestPanoramaFixedProfile(MarionetteTestCase):
    """Run the fixed fresh-profile and migrated-profile trial scenarios."""

    def setUp(self):
        super().setUp()
        self.original_prefs = self.marionette.instance.prefs
        self.created_work = set()
        self.extension_dir = None
        self.profile = None
        self.marionette.timeout.script = 240

    def tearDown(self):
        try:
            if self.marionette.session:
                self.marionette.set_context(self.marionette.CONTEXT_CHROME)
                self.perform("stop-server")
            self.stop_application()
            self.marionette.instance.restart(prefs=self.original_prefs, clean=True)
            self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
            self.marionette.start_session()
            for work in self.created_work:
                # Remove only this disposable profile's exact migration folder.
                self.assertTrue(work.name.startswith("panorama-migration-"))
                shutil.rmtree(work)
            if self.extension_dir:
                shutil.rmtree(self.extension_dir)
        finally:
            super().tearDown()

    def prefs(self, enabled):
        return {
            **(self.original_prefs or {}),
            "mail.panorama.enabled": enabled,
            "mailnews.database.global.indexer.enabled": True,
            "mailnews.mark_message_read.auto": False,
            "mail.closeToTray": False,
        }

    def stop_application(self):
        """Settle ordinary writers and release the real profile lock."""
        if self.marionette.session:
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.execute_script("Services.prefs.savePrefFile(null);")
            self.marionette.quit(in_app=True)

    def clean_profile(self, enabled):
        """Start the ordinary runner with a new disposable profile."""
        self.stop_application()
        self.marionette.instance.restart(prefs=self.prefs(enabled), clean=True)
        self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
        self.marionette.start_session()
        # A new session starts with the default 30 second script timeout.
        self.marionette.timeout.script = 240
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.profile = Path(
            self.marionette.execute_script(
                "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
            )
        ).resolve()
        self.assertEqual("mail:3pane", self.marionette.get_window_type())
        self.assertEqual(enabled, self.marionette.get_pref("mail.panorama.enabled"))

    def restart_same_profile(self, enabled):
        """Quit normally, then start the same profile with the pref value."""
        self.stop_application()
        self.marionette.instance.profile.set_preferences(
            {"mail.panorama.enabled": enabled}
        )
        self.marionette.start_session()
        # A new session starts with the default 30 second script timeout.
        self.marionette.timeout.script = 240
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        selected = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        self.assertEqual(self.profile, Path(selected).resolve())
        self.assertEqual(enabled, self.marionette.get_pref("mail.panorama.enabled"))
        self.assertEqual("mail:3pane", self.marionette.get_window_type())

    def selection(self):
        """Read the durable selector and the running native identity."""
        result = self.marionette.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            (async () => {
              const { MailGlue } = ChromeUtils.importESModule(
                'resource:///modules/MailGlue.sys.mjs');
              await MailGlue.panoramaStartup;
              const profile = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
              const record = await IOUtils.readJSON(
                PathUtils.join(profile, 'panorama-profile.json'));
              const core = Cc['@mozilla.org/mailnews/database-core;1']
                .getService(Ci.nsIDatabaseCore);
              return {record, sourceId: core.sourceId};
            })().then(done, error => done({error: String(error)}));
            """
        )
        self.assertNotIn("error", result)
        record = result["record"]
        self.assertEqual("active", record["state"])
        self.assertEqual("panorama", record["backend"])
        self.assertEqual(result["sourceId"], record["identity"]["databaseSourceId"])
        if record["identity"]["backup"]:
            self.created_work.add(
                Path(record["identity"]["backup"]["path"]).parent.parent
            )
        return result

    def perform(self, action, **args):
        result = self.marionette.execute_async_script(
            SCRIPT, script_args=[action, args]
        )
        if isinstance(result, dict) and "error" in result:
            self.fail(f"{action}: {result['error']}\n{result.get('stack')}")
        return result

    def command(self, command, uri=None, message_id=None, target=None):
        """Run one real thread-pane command on the selected message."""
        self.perform(
            "command", command=command, uri=uri, messageId=message_id, target=target
        )

    def selector_bytes(self):
        return (self.profile / "panorama-profile.json").read_bytes()

    def folder(self, uri):
        return self.perform("snapshot", uris=[uri])["folders"][uri]

    def wait_folder(self, uri, message_ids, message):
        """Wait until a folder holds exactly these Message-IDs."""
        Wait(self.marionette, timeout=60).until(
            lambda _: sorted(m["messageId"] for m in self.folder(uri) or [])
            == sorted(message_ids),
            message=message,
        )
        return self.folder(uri)

    def assert_display(self, uri, expected):
        shown = self.perform(
            "display", uri=uri, messageId=expected["messageId"], body=expected["body"]
        )
        self.assertEqual(uri, shown["folderURI"])
        self.assertEqual(expected["subject"], shown["subject"])
        self.assertEqual(expected["from"], shown["author"])
        self.assertIn(expected["body"], shown["text"])

    def assert_stored(self, row, expected):
        """Match recorded identity and real stored content of one message."""
        self.assertEqual(expected["messageId"], row["messageId"])
        self.assertEqual(expected["subject"], row["subject"])
        self.assertEqual(expected["from"], row["author"])
        self.assertEqual(expected["to"], row["recipients"])
        self.assertIsNotNone(
            row["raw"], "The message body must be stored: %s" % row["rawError"]
        )
        self.assertIn(expected["body"], row["raw"])

    def test_fresh_profile_fixed_sequence(self):
        self.clean_profile(True)
        selected = self.selection()
        self.assertEqual("initialized-empty", selected["record"]["origin"])
        self.assertIsNone(selected["record"]["identity"]["backup"])
        self.assertEqual([], selected["record"]["identity"]["imports"])

        # Create the account and folders, then receive one IMAP message.
        f = self.perform("fresh-setup")
        message = f["messages"][0]
        mid = message["messageId"]
        inbox = self.wait_folder(f["inbox"], [mid], "The IMAP message is received")
        self.assertTrue(self.perform("snapshot", uris=[])["native"])
        self.assert_display(f["inbox"], message)

        # Copy, move and delete through the real thread-pane commands; undo each.
        self.command("cmd_copyMessage", f["inbox"], mid, f["a"])
        self.wait_folder(f["a"], [mid], "Copy reaches folder A")
        self.command("cmd_undo")
        self.wait_folder(f["a"], [], "Undo removes the copy")
        self.wait_folder(f["inbox"], [mid], "Undo keeps the original")

        self.command("cmd_copyMessage", f["inbox"], mid, f["a"])
        self.wait_folder(f["a"], [mid], "Copy reaches folder A again")
        self.command("cmd_moveMessage", f["a"], mid, f["b"])
        self.wait_folder(f["b"], [mid], "Move reaches folder B")
        self.wait_folder(f["a"], [], "Move leaves folder A")
        self.command("cmd_undo")
        self.wait_folder(f["a"], [mid], "Undo returns the move to folder A")
        self.wait_folder(f["b"], [], "Undo empties folder B")

        self.command("cmd_delete", f["a"], mid)
        self.wait_folder(f["a"], [], "Delete leaves folder A")
        self.wait_folder(f["trash"], [mid], "Delete moves to Trash")
        self.command("cmd_undo")
        self.wait_folder(f["a"], [mid], "Undo restores the deleted message")
        self.wait_folder(f["trash"], [], "Undo empties Trash")

        uris = [f["inbox"], f["a"], f["b"], f["trash"]]
        before = self.perform("snapshot", uris=uris)
        self.assert_stored(before["folders"][f["a"]][0], message)
        self.assertEqual(inbox[0]["key"], before["folders"][f["inbox"]][0]["key"])
        self.assert_display(f["a"], message)
        self.perform("stop-server")
        selector = self.selector_bytes()

        # Reopen the profile twice; the same database and data are reused.
        for _ in range(2):
            self.restart_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(selector, self.selector_bytes())
            after = self.perform("snapshot", uris=uris)
            self.assertTrue(after["native"])
            for uri, rows in before["folders"].items():
                self.assertEqual(
                    [(r["key"], r["messageId"]) for r in rows],
                    [(r["key"], r["messageId"]) for r in after["folders"][uri]],
                    "Reopen keeps " + uri,
                )
            self.assert_stored(after["folders"][f["a"]][0], message)
            self.assert_display(f["a"], message)
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.assertFalse(work.exists(), "An empty profile needs no migration backup")

    def test_migrated_profile_open_search_conversation_extension(self):
        # Build a disposable legacy-default profile with genuine local/IMAP data.
        self.clean_profile(False)
        legacy = self.perform("legacy-setup")
        imap = legacy["imapMessages"]
        local = legacy["localMessages"]
        expected = {legacy["inbox"]: imap, legacy["local"]: local}
        for uri, messages in expected.items():
            ids = [m["messageId"] for m in messages]
            self.wait_folder(uri, ids, "Legacy data exists")
        recorded = self.perform("snapshot", uris=list(expected))
        self.assertFalse(recorded["native"], "The legacy default must stay in use")
        # The legacy data itself must hold every body, IMAP ones offline.
        for uri, messages in expected.items():
            rows = {r["messageId"]: r for r in recorded["folders"][uri]}
            for m in messages:
                self.assert_stored(rows[m["messageId"]], m)
        for row in recorded["folders"][legacy["inbox"]]:
            self.assertTrue(row["offline"] and row["hasMsgOffline"], row["messageId"])
        self.perform("stop-server")
        self.stop_application()
        self.assertFalse((self.profile / "panorama.sqlite").exists())
        # Keep the real legacy folder-cache rows in the log for diagnosis.
        cache = self.profile / "folderCache.json"
        rows = json.loads(cache.read_text()) if cache.exists() else None
        imap_rows = {k: v for k, v in (rows or {}).items() if "ImapMail" in k}
        print("S711 legacy folderCache.json IMAP rows: " + json.dumps(imap_rows))
        panacea = (self.profile / "panacea.dat").exists()
        print("S711 legacy panacea.dat exists: %s" % panacea)

        # Opt in and restart: the existing backup/import/activation flow runs.
        self.restart_same_profile(True)
        selected = self.selection()
        record = selected["record"]
        self.assertEqual("migrated", record["origin"])
        self.assertTrue(record["identity"]["imports"])
        archive = json.loads(Path(record["identity"]["backup"]["path"]).read_text())
        self.assertTrue(archive["complete"])
        migrated = self.perform("snapshot", uris=list(expected))
        self.assertTrue(migrated["native"])
        for uri, messages in expected.items():
            new = {r["messageId"]: r for r in migrated["folders"][uri]}
            old = {r["messageId"]: r for r in recorded["folders"][uri]}
            self.assertEqual(sorted(old), sorted(new))
            for m in messages:
                self.assert_stored(new[m["messageId"]], m)
                self.assertEqual(old[m["messageId"]]["raw"], new[m["messageId"]]["raw"])
                self.assert_display(uri, m)

        # Search, facets and conversation over the migrated data.
        found = self.perform(
            "search",
            term="s711migratedneedle",
            conversationMessageId=local[1]["messageId"],
            uris=list(expected),
        )
        hits = sorted((h["folderURI"], h["messageId"]) for h in found["hits"])
        self.assertEqual(
            sorted((uri, m["messageId"]) for uri, ms in expected.items() for m in ms),
            hits,
        )
        keys = {
            r["messageId"]: r["key"] for u in expected for r in migrated["folders"][u]
        }
        for h in found["hits"]:
            self.assertEqual(keys[h["messageId"]], h["key"])
        self.assertTrue(
            any(f["groups"] for f in found["facets"]),
            "Facets are built from the migrated results",
        )
        self.assertEqual(
            sorted((legacy["local"], m["messageId"]) for m in local),
            sorted((c["folderURI"], c["messageId"]) for c in found["conversation"]),
        )

        # A real temporary extension reads the migrated messages.
        everything = imap + local
        self.extension_dir = Path(tempfile.mkdtemp(prefix="s711-extension-"))
        manifest = {
            "manifest_version": 2,
            "name": "S711 fixed profile reader",
            "version": "1.0",
            "browser_specific_settings": {"gecko": {"id": EXTENSION_ID}},
            "background": {"scripts": ["background.js"]},
            "permissions": ["accountsRead", "messagesRead"],
        }
        (self.extension_dir / "manifest.json").write_text(json.dumps(manifest))
        wanted = [{"messageId": m["messageId"], "body": m["body"]} for m in everything]
        background = EXTENSION_BACKGROUND.replace("__PREFIX__", EXTENSION_PREFIX)
        (self.extension_dir / "background.js").write_text(
            background.replace("__EXPECTED__", json.dumps(wanted))
        )
        Addons(self.marionette).install(str(self.extension_dir), temp=True)
        report = Wait(self.marionette, timeout=60).until(
            lambda _: self.perform("extension-report", prefix=EXTENSION_PREFIX),
            message="The extension reports its message access",
        )
        self.assertNotIn("error", report if isinstance(report, dict) else {})
        by_id = {item["messageId"]: item["rows"] for item in report}
        for m in everything:
            self.assertEqual(1, len(by_id[m["messageId"]]), m["messageId"])
            row = by_id[m["messageId"]][0]
            self.assertEqual(m["messageId"], row["headerMessageId"])
            self.assertEqual(m["subject"], row["subject"])
            self.assertEqual(m["from"], row["author"])
            self.assertTrue(row["hasBody"], m["messageId"])
        Addons(self.marionette).uninstall(EXTENSION_ID)

        # Later restarts reuse the migrated database without importing again.
        selector = self.selector_bytes()
        self.restart_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(selector, self.selector_bytes())
        again = self.perform("snapshot", uris=list(expected))
        for uri in expected:
            self.assertEqual(
                [(r["key"], r["messageId"]) for r in migrated["folders"][uri]],
                [(r["key"], r["messageId"]) for r in again["folders"][uri]],
            )
