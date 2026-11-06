# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import json
import tempfile
import uuid
from pathlib import Path

from marionette_harness import MarionetteTestCase


class TestPanoramaStartupBackup(MarionetteTestCase):
    """Copy the real stopped profile at ordinary comm app-startup."""

    def setUp(self):
        super().setUp()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.profile = Path(self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        ))
        self.original_args = list(self.marionette.instance.app_args or [])
        self.instance_prefs = self.marionette.instance.prefs
        self.saved_prefs = {}
        self.work = tempfile.TemporaryDirectory(prefix="comm-startup-copy-")
        self.root = Path(self.work.name)
        self.addCleanup(self.work.cleanup)
        self.source = self.profile / ("startup-copy-" + uuid.uuid4().hex)
        self.source.write_bytes(b"Original profile message bytes.\n")
        self.changed_prefs = {}

    def set_pref(self, name, value):
        """Save each original user value before persisting a test preference."""
        if name not in self.saved_prefs:
            self.saved_prefs[name] = (
                self.marionette.execute_script(
                    "return Services.prefs.prefHasUserValue(arguments[0]);",
                    script_args=[name],
                ),
                self.marionette.get_pref(name),
            )
        self.marionette.set_pref(name, value)
        self.changed_prefs[name] = value

    def stop(self):
        """Close ordinary application writers through the normal test runner."""
        self.marionette.execute_script("Services.prefs.savePrefFile(null);")
        self.marionette.quit(in_app=True)

    def start(self, extra_args=None):
        """Start the same profile with the normal runner and selected flags."""
        self.marionette.instance.app_args = self.original_args + (extra_args or [])
        self.marionette.instance.prefs = {
            **(self.instance_prefs or {}), **self.changed_prefs
        }
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.assertEqual(str(self.profile), self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        ))
        self.assertEqual("mail:3pane", self.marionette.get_window_type())

    def startup_code(self):
        """Read the existing recorder's actual profile-do-change observation."""
        return self.marionette.execute_script("""
            const recorder = Cc['@mozilla.org/test/startuprecorder;1']
                .getService(Ci.nsIObserver).wrappedJSObject;
            return recorder.data.code['before profile selection'];
        """)

    def tearDown(self):
        try:
            if not self.marionette.session:
                self.marionette.instance.app_args = self.original_args
                self.marionette.start_session()
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            for name, (user, value) in self.saved_prefs.items():
                if user:
                    self.marionette.set_pref(name, value)
                else:
                    self.marionette.clear_pref(name)
            self.marionette.execute_script("Services.prefs.savePrefFile(null);")
            self.marionette.quit(in_app=True)
            self.source.unlink(missing_ok=True)
            self.marionette.instance.app_args = self.original_args
            self.marionette.instance.prefs = self.instance_prefs
            self.marionette.start_session()
        finally:
            super().tearDown()

    def test_before_writers_default_and_failed_copy(self):
        """Verify the actual copy, startup phase, defaults and input rejection."""
        self.set_pref("browser.startup.record", True)
        self.set_pref("mailnews.database.global.indexer.enabled", False)
        self.set_pref("offline.startup_state", 2)
        key = "s508" + uuid.uuid4().hex
        mbox = self.root / "mbox"
        maildir = self.root / "maildir"
        mbox.mkdir()
        (maildir / "Inbox" / "cur").mkdir(parents=True)
        (mbox / "Inbox").write_bytes(b"From sender\nSubject: mbox\n\nBody.\n")
        body = maildir / "Inbox" / "cur" / "message"
        body.write_bytes(bytes(range(256)) * 4097)
        self.set_pref(f"mail.server.{key}box.directory", str(mbox))
        self.set_pref(f"mail.server.{key}box.type", "imap")
        self.set_pref(f"mail.server.{key}dir.directory", str(self.root / "wrong"))
        relative = self.marionette.execute_script("""
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(arguments[0]);
            return '[ProfD]' + file.getRelativeDescriptor(
                Services.dirsvc.get('ProfD', Ci.nsIFile));
        """, script_args=[str(maildir)])
        self.set_pref(f"mail.server.{key}dir.directory-rel", relative)
        self.set_pref(f"mail.server.{key}dir.type", "imap")
        expected = {
            self.source: hashlib.sha256(self.source.read_bytes()).hexdigest(),
            mbox / "Inbox": hashlib.sha256((mbox / "Inbox").read_bytes()).hexdigest(),
            body: hashlib.sha256(body.read_bytes()).hexdigest(),
        }
        self.stop()
        # These are ordinary closed-profile files, not a synthetic NSS facade.
        nss = {name: (self.profile / name).read_bytes()
               for name in ("cert9.db", "key4.db", "pkcs11.txt")
               if (self.profile / name).exists()}
        backup = self.root / "backup"
        self.start(["--panorama-backup", str(backup)])
        manifest_path = backup / "manifest.json"
        self.assertTrue(
            manifest_path.exists(),
            "Opt-in startup must publish its backup before normal writers start",
        )
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertIs(manifest["complete"], True)
        for source, digest in expected.items():
            root = next(item for item in manifest["roots"]
                        if source.is_relative_to(Path(item["source"])))
            copy = backup / root["directory"] / source.relative_to(root["source"])
            self.assertEqual(digest, hashlib.sha256(copy.read_bytes()).hexdigest())
        profile_root = next(item for item in manifest["roots"]
                            if Path(item["source"]) == self.profile)
        for name, before in nss.items():
            self.assertEqual(before, (backup / profile_root["directory"] / name).read_bytes())
        code = self.startup_code()
        self.assertIn("resource:///modules/panorama/MigrationBackup.sys.mjs", code["modules"])
        self.assertNotIn("@mozilla.org/messenger/account-manager;1", code["services"])
        self.assertNotIn("@mozilla.org/msgDatabase/msgDBService;1", code["services"])
        for module in (
            "resource:///modules/logger.sys.mjs",
            "resource:///modules/gloda/GlodaPublic.sys.mjs",
            "resource:///modules/panorama/MailSearch.sys.mjs",
            "resource:///modules/panorama/ChatSearchService.sys.mjs",
        ):
            self.assertNotIn(module, code["modules"])
        verified = self.marionette.execute_async_script("""
            const done = arguments[arguments.length - 1];
            const { verifyMigrationBackup } = ChromeUtils.importESModule(
                'resource:///modules/panorama/MigrationBackup.sys.mjs');
            verifyMigrationBackup(arguments[0]).then(done, e => done({error: String(e)}));
        """, script_args=[str(backup)])
        self.assertNotIn("error", verified)
        self.assertEqual(hashlib.sha256(manifest_bytes).hexdigest(), verified["sha256"])

        self.stop()
        body.write_bytes(b"Normal later source write.\n")
        self.start()
        self.assertEqual(manifest_bytes, manifest_path.read_bytes())
        self.assertNotIn("resource:///modules/panorama/MigrationBackup.sys.mjs",
                         self.startup_code()["modules"])
        self.stop()
        unsafe = self.profile / ("unsafe-backup-" + uuid.uuid4().hex)
        self.start(["--panorama-backup", str(unsafe)])
        self.assertFalse(unsafe.exists(), "Unsafe copy must not publish even an incomplete archive")
        self.assertEqual(b"Normal later source write.\n", body.read_bytes())
        self.assertEqual(manifest_bytes, manifest_path.read_bytes())
