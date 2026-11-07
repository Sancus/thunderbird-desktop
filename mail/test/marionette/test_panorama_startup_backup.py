# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import json
import shutil
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
        )).resolve()
        self.original_args = list(self.marionette.instance.app_args or [])
        self.instance_prefs = self.marionette.instance.prefs
        self.saved_prefs = {}
        self.work = tempfile.TemporaryDirectory(prefix="comm-startup-copy-")
        self.root = Path(self.work.name).resolve()
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
        selected = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        self.assertEqual(self.profile, Path(selected).resolve())
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
                        if source.is_relative_to(Path(item["source"]).resolve()))
            copy = backup / root["directory"] / source.relative_to(Path(root["source"]).resolve())
            self.assertEqual(digest, hashlib.sha256(copy.read_bytes()).hexdigest())
        profile_root = next(item for item in manifest["roots"]
                            if Path(item["source"]).resolve() == self.profile)
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

    def tree_snapshot(self, root):
        """Independently read every directory and file byte in a physical tree."""
        entries = {}
        for path in sorted(root.rglob("*")):
            self.assertFalse(path.is_symlink(), "Restore trees must not contain links")
            relative = path.relative_to(root).as_posix()
            if path.is_dir():
                entries[relative] = {"type": "directory"}
            else:
                self.assertTrue(path.is_file(), "Restore entries must be regular files")
                data = path.read_bytes()
                entries[relative] = {
                    "type": "regular",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
        return entries

    def stage_restore(self, backup, parent):
        """Call the existing restore API and return its actual result or error."""
        return self.marionette.execute_async_script("""
            const done = arguments[arguments.length - 1];
            const { stageMigrationRestore } = ChromeUtils.importESModule(
                'resource:///modules/panorama/MigrationBackup.sys.mjs');
            stageMigrationRestore(arguments[0], arguments[1])
                .then(done, error => done({ error: String(error) }));
        """, script_args=[str(backup), str(parent)])

    def staged_metadata(self, path, root):
        """Read restored modes and times with the platform's native file API."""
        return self.marionette.execute_script("""
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(arguments[0]);
            const entries = [{ parts: [] }, ...arguments[1].entries];
            return Object.fromEntries(entries.map(entry => {
                const child = file.clone();
                for (const part of entry.parts) {
                    child.append(part);
                }
                return [entry.parts.join('/'), {
                    permissions: child.permissions,
                    lastModified: child.lastModifiedTime,
                }];
            }));
        """, script_args=[str(path), root])

    def test_completeBackupAndIndependentRestore(self):
        """Restore every real profile/store entry without changing the originals."""
        self.set_pref("mailnews.database.global.indexer.enabled", False)
        self.set_pref("offline.startup_state", 2)
        key = "s510" + uuid.uuid4().hex
        mbox = self.root / "mbox"
        maildir = self.root / "maildir"
        mbox.mkdir()
        for name in ("cur", "new", "tmp"):
            (maildir / "Inbox" / name).mkdir(parents=True)
        (mbox / "Inbox").write_bytes(b"From backup\nSubject: mbox\n\nExact bytes.\n")
        body = maildir / "Inbox" / "cur" / "message"
        body.write_bytes(bytes(range(256)) * 4097)
        (maildir / "zero-length").write_bytes(b"")
        self.set_pref(f"mail.server.{key}box.directory", str(mbox))
        self.set_pref(f"mail.server.{key}box.type", "imap")
        self.set_pref(f"mail.server.{key}dir.directory", str(maildir))
        self.set_pref(f"mail.server.{key}dir.type", "imap")
        expected = {
            self.source: self.source.read_bytes(),
            mbox / "Inbox": (mbox / "Inbox").read_bytes(),
            body: body.read_bytes(),
        }
        self.stop()
        nss = {
            name: (self.profile / name).read_bytes()
            for name in ("cert9.db", "key4.db", "pkcs11.txt")
            if (self.profile / name).exists()
        }
        external_before = {
            root.resolve(): self.tree_snapshot(root) for root in (mbox, maildir)
        }
        backup = self.root / "complete-backup"
        self.start(["--panorama-backup", str(backup)])
        manifest_path = backup / "manifest.json"
        self.assertTrue(manifest_path.exists(), "Startup must publish the full backup")
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertIs(manifest["complete"], True)
        roots = {Path(root["source"]).resolve(): root for root in manifest["roots"]}
        self.assertEqual({self.profile, mbox.resolve(), maildir.resolve()}, set(roots))
        self.assertEqual(len(manifest["roots"]), len(roots))
        archive = {
            original: self.tree_snapshot(backup / root["directory"])
            for original, root in roots.items()
        }
        for original, root in roots.items():
            declared = {}
            for entry in root["entries"]:
                value = {"type": entry["type"]}
                if entry["type"] == "regular":
                    value.update(size=entry["size"], sha256=entry["sha256"])
                declared["/".join(entry["parts"])] = value
            self.assertEqual(declared, archive[original], "Full archive inventory must match")
        for source, value in expected.items():
            root = next(root for root in roots.values()
                        if source.is_relative_to(Path(root["source"]).resolve()))
            copied = backup / root["directory"] / source.relative_to(Path(root["source"]).resolve())
            self.assertEqual(value, copied.read_bytes(), "Stopped source bytes must survive")
        profile_root = roots[self.profile]
        for name, value in nss.items():
            self.assertEqual(value, (backup / profile_root["directory"] / name).read_bytes())
        for original, snapshot in external_before.items():
            self.assertEqual(snapshot, archive[original])

        # A restore nests the backed-up profile storage one level deeper than
        # the backup; keep its parent shallow so Windows paths stay valid.
        restore_work = tempfile.TemporaryDirectory(prefix="r")
        self.addCleanup(restore_work.cleanup)
        parent = Path(restore_work.name).resolve() / "p"
        parent.mkdir()
        restored = self.stage_restore(backup, parent)
        self.assertNotIn("error", restored, restored)
        restore_path = Path(restored["path"]).resolve()
        self.assertEqual(parent, restore_path.parent)
        restored_roots = {Path(item["original"]).resolve(): Path(item["staged"]).resolve()
                          for item in restored["roots"]}
        self.assertEqual(set(roots), set(restored_roots))
        self.assertEqual(len(roots), len(restored["roots"]))
        # Read the real staged trees with independent Python I/O.
        for original, target in restored_roots.items():
            self.assertTrue(target.is_relative_to(restore_path))
            self.assertEqual(
                archive[original], self.tree_snapshot(target),
                "Restored tree must match independent complete archive inventory",
            )
            root = roots[original]
            metadata = {"": {name: root[name]
                             for name in ("permissions", "lastModified")}}
            metadata.update({
                "/".join(entry["parts"]): {name: entry[name]
                                         for name in ("permissions", "lastModified")}
                for entry in root["entries"]
            })
            self.assertEqual(metadata, self.staged_metadata(target, root))

        sentinel = restored_roots[self.profile] / "restored-only-marker"
        sentinel.write_bytes(b"Do not overwrite an earlier staged restore.\n")
        second = self.stage_restore(backup, parent)
        self.assertNotIn("error", second, second)
        self.assertNotEqual(restore_path, Path(second["path"]).resolve())
        self.assertEqual(b"Do not overwrite an earlier staged restore.\n", sentinel.read_bytes())
        for item in second["roots"]:
            self.assertEqual(archive[Path(item["original"]).resolve()],
                             self.tree_snapshot(Path(item["staged"]).resolve()))

        corrupt = self.root / "corrupt-backup"
        shutil.copytree(backup, corrupt)
        (corrupt / profile_root["directory"] / self.source.name).write_bytes(b"corrupt")
        before_refusal = set(parent.iterdir())
        refused = self.stage_restore(corrupt, parent)
        self.assertIn("error", refused)
        self.assertIn("Migration backup file differs from its source", refused["error"])
        self.assertEqual(before_refusal, set(parent.iterdir()),
                         "Verification failure must not create restore staging")
        self.assertEqual(manifest_bytes, manifest_path.read_bytes())
        for original, root in roots.items():
            self.assertEqual(archive[original], self.tree_snapshot(backup / root["directory"]))
        for original, snapshot in external_before.items():
            self.assertEqual(snapshot, self.tree_snapshot(Path(original)))
        self.assertEqual(expected[self.source], self.source.read_bytes())
