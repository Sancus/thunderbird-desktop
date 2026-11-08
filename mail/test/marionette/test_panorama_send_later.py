# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

from pathlib import Path

from marionette_harness import MarionetteTestCase

SCRIPT = (Path(__file__).parent / "scripts" / "send_later.js").read_text(
    encoding="utf-8"
)


class TestPanoramaSendLater(MarionetteTestCase):
    def setUp(self):
        super().setUp()
        self.fixture = None
        self.saved_prefs = {}
        self.instance_prefs = self.marionette.instance.prefs
        self.restored = False
        try:
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.initial_profile = self.marionette.execute_script(
                "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
            )
            prefs = {
                "mail.panorama.enabled": True,
                "mailnews.database.global.indexer.enabled": False,
                "mailnews.sendInBackground": False,
                # Keep queued messages until the explicit post-restart send.
                "offline.send.unsent_messages": 2,
            }
            for name, value in prefs.items():
                self.saved_prefs[name] = {
                    "user": self.marionette.execute_script(
                        "return Services.prefs.prefHasUserValue(arguments[0]);",
                        script_args=[name],
                    ),
                    "value": self.marionette.get_pref(name),
                }
                self.marionette.set_pref(name, value)
            self.marionette.instance.prefs = {**(self.instance_prefs or {}), **prefs}
            self.restart_same_profile()
            result = self.perform("setup")
            self.fixture = result["fixture"]
            self.before = result["snapshot"]
            self.assertEqual([{"count": 1, "status": 0}] * 2, result["completions"])
            self.assert_backend(self.before)
            self.assertEqual(2, len(self.before["queue"]))
            self.assertEqual([], self.before["sent"])
            self.assertEqual(1, len(self.before["control"]))
            for n, header in enumerate(self.before["queue"], 1):
                self.assertEqual(self.fixture["outbox"], header["folderURI"])
                self.assertEqual(f"s375-queue-{n}@example.invalid", header["messageId"])
                self.assertEqual(f"S375 queued message {n}", header["subject"])
                self.assertIn(f"S375 exact queued body {n}.", header["raw"])
                self.assertIn("queued-s375@example.invalid", header["author"])
            self.assertEqual(
                self.before["queue"][0]["messageId"],
                self.before["control"][0]["messageId"],
            )
            self.assertNotEqual(
                self.before["queue"][0]["folderURI"],
                self.before["control"][0]["folderURI"],
            )
        except Exception:
            try:
                self.restore()
            except Exception:
                self.logger.error(
                    "Failed to restore the Send Later fixture after setup failed",
                    exc_info=True,
                )
            raise

    def perform(self, action, reject_delivery=False):
        """Run the real store/SMTP operation and surface every fixture error."""
        result = self.marionette.execute_async_script(
            SCRIPT, script_args=[action, self.fixture, reject_delivery]
        )
        if action == "setup" and result.get("fixture"):
            self.fixture = result["fixture"]
        self.assertNotIn("error", result, result)
        return result["value"]

    def restart_clean_profile(self):
        """Continue on a fresh ordinary profile with the original preferences.

        The pref-enabled restart selected Panorama for the test profile, and a
        selected profile does not return to Mork by preference.
        """
        if self.marionette.session:
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.quit(in_app=True)
        self.marionette.instance.restart(prefs=self.instance_prefs, clean=True)
        self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)

    def restart_same_profile(self):
        """Restart the application process with the same persistent profile."""
        old_pid = self.marionette.execute_script("return Services.appinfo.processID;")
        capabilities = self.marionette.requested_capabilities
        details = self.marionette.quit(in_app=True, clean=False)
        self.assertTrue(details["in_app"], "Expected in-app shutdown")
        self.assertFalse(details["forced"], "Expected non-forced shutdown")
        self.assertEqual(self.marionette.instance.runner.returncode, 0)
        self.marionette.start_session(capabilities)
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.marionette.switch_to_window(self.marionette.chrome_window_handles[0])
        self.assertNotEqual(
            old_pid,
            self.marionette.execute_script("return Services.appinfo.processID;"),
        )
        self.assertEqual(
            self.initial_profile,
            self.marionette.execute_script(
                "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
            ),
        )

    def assert_backend(self, snapshot):
        """Require the installed native database and real local mbox store."""
        self.assertTrue(snapshot["native"])
        self.assertTrue(snapshot["enabled"])
        self.assertFalse(snapshot["indexer"])
        self.assertNotEqual(
            "{03223c50-1e88-45e8-ba1a-7ce792dc3fc3}", snapshot["nativeCID"]
        )
        self.assertEqual("mbox", snapshot["store"])
        self.assertEqual(self.initial_profile, snapshot["profile"])

    def assert_queue_unchanged(self, snapshot):
        """Require both original physical queue members and unrelated control."""
        self.assert_backend(snapshot)
        self.assertEqual(self.before["queue"], snapshot["queue"])
        self.assertEqual(self.before["control"], snapshot["control"])
        self.assertEqual([], snapshot["sent"])

    def assert_success(self, result):
        """Require one completed delivery for each original physical member."""
        self.assertEqual([2], result["starts"])
        self.assertEqual([], result["errors"])
        self.assertEqual([], result["alerts"])
        self.assertEqual(
            [{"status": 0, "tried": 2, "successful": 2}], result["stops"]
        )
        self.assertFalse(result["sending"])
        self.assertEqual(2, len(result["messageStarts"]))
        for n, event in enumerate(result["messageStarts"], 1):
            original = self.before["queue"][n - 1]
            self.assertEqual(
                {
                    "current": n,
                    "total": 2,
                    "folderURI": original["folderURI"],
                    "key": original["key"],
                    "messageId": original["messageId"],
                    "identity": self.fixture["identity"],
                },
                event,
            )
        snapshot = result["snapshot"]
        self.assert_backend(snapshot)
        self.assertEqual([], snapshot["queue"])
        self.assertEqual(self.before["control"], snapshot["control"])
        self.assertEqual(2, len(snapshot["sent"]))
        self.assertEqual(2, len(result["received"]))
        for n, (sent, wire) in enumerate(zip(snapshot["sent"], result["received"]), 1):
            self.assertEqual(self.fixture["sent"], sent["folderURI"])
            self.assertEqual(f"s375-queue-{n}@example.invalid", sent["messageId"])
            self.assertEqual(f"S375 queued message {n}", sent["subject"])
            self.assertIn(f"S375 exact queued body {n}.", sent["raw"])
            self.assertIn(f"S375 exact queued body {n}.", wire)
            self.assertIn(f"Message-ID: <s375-queue-{n}@example.invalid>", wire)
        self.assertEqual(
            2, len({(h["folderURI"], h["key"]) for h in snapshot["sent"]})
        )

    def test_restart_preserves_queued_physical_messages(self):
        self.restart_same_profile()
        after = self.perform("snapshot")
        self.assertNotEqual(self.before["pid"], after["pid"])
        self.assert_queue_unchanged(after)
        self.assert_success(self.perform("send"))

    def test_delivery_failure_preserves_queue_after_restart(self):
        self.restart_same_profile()
        self.assert_queue_unchanged(self.perform("snapshot"))
        failed = self.perform("send", reject_delivery=True)
        self.assertEqual([2], failed["starts"])
        self.assertEqual(
            [{"status": failed["expectedError"], "tried": 2, "successful": 0}],
            failed["stops"],
        )
        self.assertFalse(failed["sending"])
        self.assertEqual([], failed["received"])
        self.assertEqual(2, len(failed["errors"]))
        for n, event in enumerate(failed["errors"], 1):
            self.assertEqual(
                {
                    "current": n,
                    "key": self.before["queue"][n - 1]["key"],
                    "messageId": f"s375-queue-{n}@example.invalid",
                    "status": failed["expectedError"],
                },
                event,
            )
        self.assertEqual(2, len(failed["alerts"]))
        for alert in failed["alerts"]:
            self.assertIn("S375 recipient rejected", alert)
        self.assert_queue_unchanged(failed["snapshot"])
        self.restart_same_profile()
        self.assert_queue_unchanged(self.perform("snapshot"))
        self.assert_success(self.perform("send"))

    def tearDown(self):
        try:
            self.restore()
        finally:
            super().tearDown()

    def restore(self):
        """Remove only owned messages/accounts and restore startup preferences."""
        if self.restored:
            return
        self.restored = True
        try:
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.perform("cleanup")
        finally:
            self.marionette.instance.prefs = self.instance_prefs
            if self.saved_prefs:
                self.restart_clean_profile()
